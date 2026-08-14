import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AssignmentType, Timezone, LeadStatus, Role, Prisma } from '@crm/database';
import { dayInZone, timezoneWhere, tzLabel } from '../../common/timezone';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateLeadDto, ImportLeadsDto, ListLeadsQueryDto, UpdateLeadDto } from './dto/lead.dto';
import { closureCreateFields, closureFields } from './lead-closure';
import { buildMatchKeys, decisionKey, emailDomain, longestWord, type LeadMatchOptions, type MatchableRecord, type MatchSignal } from './lead-dedupe';
import { LeadIdService } from './lead-id.service';

/**
 * Shown when a same-day reassignment is refused for want of confirmation.
 *
 * A lead is assigned once a day by default, so work isn't pulled out from under
 * whoever started on it. The restriction is no longer absolute: a manager may
 * reassign the same day by confirming it deliberately, and the confirmation is
 * recorded on the history row. Come the next calendar day the lead is freely
 * assignable again, and the cycle resets on its own — nothing has to run.
 */
export const SAME_DAY_LOCK_MESSAGE =
  'This lead has already been assigned today to another employee. Do you want to reassign it?';

/**
 * Error code carried alongside that message, so the client can tell "needs
 * confirmation" apart from every other reason an assignment can fail.
 *
 * Matching on the message text would work until the wording changed, and the
 * wording is the sort of thing that changes. A prompt shown for the wrong reason
 * — or, worse, not shown for the right one — is how a manager ends up unable to
 * reassign at all, so the client keys off this.
 */
export const SAME_DAY_CONFIRM_CODE = 'SAME_DAY_REASSIGN_CONFIRM_REQUIRED';

/** The 400 body a caller gets when confirmation is what's missing. */
export function sameDayConfirmError(leads: { id: string; leadId: string; assignedTo: string | null }[]) {
  return {
    statusCode: 400,
    code: SAME_DAY_CONFIRM_CODE,
    message: SAME_DAY_LOCK_MESSAGE,
    /** Which leads need the confirmation, so the prompt can name them. */
    leads,
  };
}

/** Rows a page holds when the caller doesn't say. Enough to fill a screen and
 *  scroll a little; small enough that opening the module is one small response. */
const DEFAULT_PAGE_SIZE = 50;

type ImportLeadMatch = {
  id: string; leadId: string; businessName: string; phone: string; altPhone: string | null;
  email: string | null; website: string | null; assignedTo: string | null; assignedToId: string | null;
  createdAt: Date; leadGenerationId: string | null; leadSource: string | null; contactName: string | null;
  contactName2: string | null; socialMedia: string | null; country: string | null; state: string | null;
  city: string | null; timezone: string | null; industry: string | null; companySize: string | null;
  foundedYear: string | null; address: string | null; callStatus: string | null; lostReason: string | null;
  status: string;
};

/**
 * The columns the lead grid actually renders, plus the few the row actions need.
 *
 * The list used to return whole Lead rows — every Quo sync field, every reminder
 * stamp, the raw provider JSON. Measured on 50 rows: 1,253 bytes a row before,
 * 974 after, a 22% cut. Modest, because the grid and the CSV export between them
 * legitimately use most of the remaining columns; the large saving on this
 * endpoint is paging (1.19 MB for a thousand rows against 48 KB for a page of
 * fifty), and this is on top of it.
 *
 * Adding a column here is how a new grid column gets its data — including for
 * the export, which reads the same endpoint.
 */
const LIST_SELECT = {
  id: true,
  /** The import position — the grid's default order, and a column users can show. */
  importSeq: true,
  leadId: true,
  leadGenerationId: true,
  businessName: true,
  contactName: true,
  contactName2: true,
  phone: true,
  altPhone: true,
  email: true,
  website: true,
  socialMedia: true,
  country: true,
  state: true,
  city: true,
  timezone: true,
  status: true,
  callStatus: true,
  industry: true,
  companySize: true,
  foundedYear: true,
  address: true,
  comments: true,
  leadSource: true,
  qualityScore: true,
  callbackAt: true,
  callbackCompletedAt: true,
  nextFollowUpDate: true,
  firstContact: true,
  lastContact: true,
  followupCount: true,
  meetingDate: true,
  lostReason: true,
  lastCommunicationAt: true,
  quoStatus: true,
  createdAt: true,
  updatedAt: true,
  closedAt: true,
  assignedToId: true,
  assignedTo: { select: { id: true, name: true, email: true } },
  closedBy: { select: { id: true, name: true, email: true } },
  /**
   * The row's SCHEDULED date, and how it came to be scheduled for that day.
   *
   * This is the second of the module's two dates and must not be confused with
   * the first. `createdAt` above is when the lead was originally created and is
   * never rewritten by anything; this is the day the lead is currently on
   * somebody's queue for, which moves — a manager reassigns it, or the overnight
   * carry-forward rolls an unfinished lead into its next local day.
   *
   * `type` comes with it so the grid can say WHY the lead sits on that date:
   * `new_assignment`, `reassignment`, or `carry_forward` (moved to the next day).
   */
  assignments: {
    where: { isActive: true },
    orderBy: { assignedAt: 'desc' },
    take: 1,
    select: { assignedAt: true, type: true },
  },
  /**
   * How many times this lead has been rolled into a new day without being
   * finished — the "moved to the next day" count the grid and the export show.
   *
   * Counted here because the row above holds only the ACTIVE assignment, so the
   * client has no way to work it out: every earlier carry-forward row is closed.
   */
  _count: { select: { assignments: { where: { type: AssignmentType.carry_forward } } } },
} satisfies Prisma.LeadSelect;

/**
 * Columns the grid may sort by, and what each one means in SQL.
 *
 * A whitelist because `sortBy` arrives from the query string and is interpolated
 * into an orderBy — an open one would let a caller order by any column, or by a
 * relation, and turn a page into a full scan and sort.
 *
 * `leadId` maps to `importSeq`. Sorting by the id STRING is wrong — "L-2026-10"
 * sorts before "L-2026-2" — and sorting by the parsed sequence number needs an
 * expression no index covers, which is a scan and a sort of the whole book on
 * the module's DEFAULT ordering. `importSeq` is the order the leads arrived in,
 * is unique and is indexed. (It used to map to `createdAt`, which is the same
 * order only until an import writes two rows in one millisecond.)
 */
const SORTABLE: Record<string, (dir: Prisma.SortOrder) => Prisma.LeadOrderByWithRelationInput> = {
  importSeq: (dir) => ({ importSeq: dir }),
  leadId: (dir) => ({ importSeq: dir }),
  createdAt: (dir) => ({ createdAt: dir }),
  businessName: (dir) => ({ businessName: dir }),
  contactName: (dir) => ({ contactName: dir }),
  phone: (dir) => ({ phone: dir }),
  email: (dir) => ({ email: dir }),
  city: (dir) => ({ city: dir }),
  state: (dir) => ({ state: dir }),
  timezone: (dir) => ({ timezone: dir }),
  status: (dir) => ({ status: dir }),
  callStatus: (dir) => ({ callStatus: dir }),
  callbackAt: (dir) => ({ callbackAt: dir }),
  lastContact: (dir) => ({ lastContact: dir }),
  closedAt: (dir) => ({ closedAt: dir }),
  assignedTo: (dir) => ({ assignedTo: { name: dir } }),
};

/** An unknown sort key falls back to the default rather than erroring: a stale
 *  bookmark or a renamed column should show the list, not a 400. */
function sortClause(key: string, dir: Prisma.SortOrder): Prisma.LeadOrderByWithRelationInput {
  return (SORTABLE[key] ?? SORTABLE.createdAt)(dir);
}

/** Fields counted when ranking which of a duplicate group's leads holds the most
 *  data — the record a purge should suggest keeping. */
const COMPLETENESS_FIELDS = [
  'businessName', 'phone', 'altPhone', 'email', 'website', 'contactName',
  'city', 'state', 'timezone', 'industry',
] as const;

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly leadIds: LeadIdService,
  ) {}

  private async log(leadId: string, userId: string, action: string, oldValue: string | null, newValue: string | null, remarks?: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { callStatus: true, assignedToId: true },
    });
    await this.prisma.activity.create({
      data: {
        leadId,
        userId,
        action,
        oldValue,
        newValue,
        remarks: remarks ?? null,
        callStatus: lead?.callStatus ?? null,
        assignedToId: lead?.assignedToId ?? null,
      },
    });
  }

  /** Resolve a free-text CALLER value (name or email) to a user id, if it
   * matches an existing user; otherwise undefined. Case-insensitive. */
  /**
   * Resolve an "Assigned To" cell to a user.
   *
   * Sheets write the owner as `Lisa - MAS21072` — a display name followed by the
   * employee code used on the floor. That code isn't stored against users, so the
   * name in front of the separator is what identifies them: try the cell verbatim
   * first (plain name or email), then fall back to the part before the dash.
   */
  /** Start of the current day — the boundary the same-day assignment lock uses. */
  static startOfToday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /**
   * Write an assignment row for a lead that just changed hands.
   *
   * Only the assignments module used to do this, so a lead assigned while being
   * created, edited or imported left no trace in `assignments` — an incomplete
   * ownership history, and no timestamp for the same-day reassignment lock to
   * read. Every path that sets `assignedToId` records one now, so "was this
   * assigned today?" has the same answer however it happened.
   */
  private async recordAssignment(
    leadId: string,
    callerId: string,
    assignedById: string,
    batchName?: string,
    opts?: { previousCallerId?: string | null; remarks?: string },
  ) {
    // The previous owner is read from the lead itself rather than from the last
    // history row: the lead is the record of who held it, and a history row
    // could be missing for a lead assigned before any of this was recorded.
    const previousCallerId =
      opts?.previousCallerId !== undefined
        ? opts.previousCallerId
        : (await this.prisma.lead.findUnique({ where: { id: leadId }, select: { assignedToId: true } }))?.assignedToId ?? null;

    await this.prisma.assignment.updateMany({ where: { leadId, isActive: true }, data: { isActive: false } });
    await this.prisma.assignment.create({
      data: {
        leadId,
        callerId,
        previousCallerId: previousCallerId && previousCallerId !== callerId ? previousCallerId : null,
        assignedById,
        batchName,
        // "Reassignment" means it came from someone else. Handing a lead back to
        // the person who already holds it is not a transfer of anything.
        type: previousCallerId && previousCallerId !== callerId ? AssignmentType.reassignment : AssignmentType.new_assignment,
        remarks: opts?.remarks,
      },
    });
  }

  /**
   * Was this lead handed to someone today?
   *
   * Every history row counts, not just the active one. Reassigning twice in a
   * day closes the first row, and if only the active row were checked the second
   * handover would look like the first — so the third would go through with no
   * confirmation at all, on the day the lead had already moved twice.
   */
  /**
   * Has this lead already been handed over today — where "today" is the day in
   * the LEAD's own time zone, not the server's?
   *
   * The server runs on IST, 9.5–13.5 hours ahead of the US. Measured against a
   * server-local midnight, an assignment made at 6pm IST on the 14th counts as
   * "the 14th" while the lead's own clock still reads the 13th — so the lock
   * fired a day early for every evening assignment, which is the entire Indian
   * working evening. Read in the lead's zone, the same assignment correctly
   * reads as the 13th and the lead is free to move again when the US 14th
   * begins.
   */
  private async assignedToday(leadId: string): Promise<boolean> {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: {
        timezone: true,
        assignments: {
          // A carry-forward is not a handover — nobody moved this lead, a sweep
          // re-stamped it for its new local day with the same owner. Counting it
          // would lock every untouched lead against reassignment the moment that
          // sweep ran, which is the opposite of what this restriction is for: it
          // protects work from being pulled out from under someone mid-shift.
          where: { type: { not: AssignmentType.carry_forward } },
          orderBy: { assignedAt: 'desc' },
          take: 1,
          select: { assignedAt: true },
        },
      },
    });
    const last = lead?.assignments[0]?.assignedAt;
    if (!last) return false;
    return dayInZone(last, lead!.timezone) === dayInZone(new Date(), lead!.timezone);
  }

  private async resolveCaller(caller?: string): Promise<string | undefined> {
    const q = caller?.trim();
    if (!q) return undefined;
    const byExact = await this.prisma.user.findFirst({
      where: { OR: [{ email: { equals: q, mode: 'insensitive' } }, { name: { equals: q, mode: 'insensitive' } }] },
      select: { id: true },
    });
    if (byExact) return byExact.id;

    // "Lisa - MAS21072" → "Lisa". Handles hyphen, en dash and em dash.
    const namePart = q.split(/\s[-–—]\s/)[0]?.trim();
    if (!namePart || namePart === q) return undefined;
    const byName = await this.prisma.user.findFirst({
      where: { OR: [{ email: { equals: namePart, mode: 'insensitive' } }, { name: { equals: namePart, mode: 'insensitive' } }] },
      select: { id: true },
    });
    return byName?.id;
  }

  /**
   * Create a lead with the next id in the `L-YYYY-N` sequence.
   *
   * Generation itself lives in LeadIdService, so a lead typed into the New Lead
   * form and one loaded from a sheet are numbered by the same rule.
   *
   * This is now the ONLY way a lead comes into existence. Inbound calls, SMS and
   * Quo contacts used to mint one for any number the CRM didn't recognise; they
   * no longer do, because that filled Lead Management with wrong numbers and
   * robocalls. An unrecognised caller is recorded as an unknown call instead —
   * see CommunicationsService.findLeadByPhone.
   */
  private createLead(buildData: (leadId: string) => Prisma.LeadCreateInput, explicitLeadId?: string) {
    return this.leadIds.create(buildData, explicitLeadId);
  }
  /** Map the optional lead-sheet fields from a DTO to Prisma data. */
  private sheetFields(dto: CreateLeadDto) {
    return {
      contactName: dto.contactName,
      industry: dto.industry,
      title: dto.title,
      employeeCode: dto.employeeCode,
      comments: dto.comments,
      leadCategory: dto.leadCategory,
      nextFollowUpDate: dto.nextFollowUpDate ? new Date(dto.nextFollowUpDate) : undefined,
      callStatus: dto.callStatus,
      firstContact: dto.firstContact ? new Date(dto.firstContact) : undefined,
      lastContact: dto.lastContact ? new Date(dto.lastContact) : undefined,
      followupCount: dto.followupCount,
      meetingDate: dto.meetingDate ? new Date(dto.meetingDate) : undefined,
      lostReason: dto.lostReason,
      leadGenerationId: dto.leadGenerationId,
      leadSource: dto.leadSource,
      contactName2: dto.contactName2,
      altPhone: dto.altPhone,
      website: dto.website,
      socialMedia: dto.socialMedia,
      country: dto.country,
      companySize: dto.companySize,
      foundedYear: dto.foundedYear,
      address: dto.address,
    };
  }
  async create(dto: CreateLeadDto, userId?: string, role?: Role) {
    /**
     * Refuse a lead that already exists, unless the caller says to make it
     * anyway. The import has warned about duplicates for a long time; this form
     * did not, so the one door with a guard on it was the one that already had
     * a review screen, and hand-typed leads walked straight past.
     *
     * A 409 rather than a silent merge: the caller is a person at a form who can
     * look at the match and decide, and quietly folding their typing into an
     * existing record is a worse answer than asking.
     */
    if (!dto.allowDuplicate) {
      const clashes = await this.findDuplicatesFor(dto);
      if (clashes.length > 0) {
        throw new ConflictException({
          message: `This lead matches ${clashes.length} existing ${clashes.length === 1 ? 'lead' : 'leads'} on ${[...new Set(clashes.flatMap((c) => c.matchedOn))].join(' and ')}.`,
          duplicates: clashes,
        });
      }
    }
    // IMP-006 — auto-generate lead_id if not provided (retries on collision).
    // Employees may not assign leads to anyone else: their created leads are
    // always owned by them (so the lead stays in their own visible book).
    // Managers may target any caller via the free-text `caller` field.
    const assignedToId =
      role === Role.employee ? userId : await this.resolveCaller(dto.caller);
    // A lead created straight into `closed` is credited to its assignee — the
    // rep whose closure the record is asserting, not whoever typed it in.
    const lead = await this.createLead(
      (leadId) => ({
        leadId,
        businessName: dto.businessName,
        phone: dto.phone,
        email: dto.email,
        state: dto.state,
        city: dto.city,
        timezone: dto.timezone,
        status: dto.status,
        ...(assignedToId ? { assignedTo: { connect: { id: assignedToId } } } : {}),
        ...closureCreateFields(dto.status, assignedToId ?? null),
        ...this.sheetFields(dto),
      }),
      dto.leadId,
    );
    if (userId) {
      await this.log(lead.id, userId, 'lead_created', null, lead.status, `Lead ${lead.leadId} created`);
      if (assignedToId) {
        await this.log(lead.id, userId, 'lead_assigned', null, assignedToId, 'Initial assignment');
        // A lead being created has no prior owner, so this is explicitly a first
        // assignment rather than something inferred from the row it just wrote.
        await this.recordAssignment(lead.id, assignedToId, userId, undefined, { previousCallerId: null });
      }
    }
    return lead;
  }

  // IMP-001/005 + AI-004 — bulk import with per-row validation and dedupe.
  /**
   * IMP-001/005 — bulk upsert. Matches an existing lead by phone (or leadId)
   * and UPDATES only the columns present in the row (missing columns are left
   * untouched), so partial files fill in remaining data. Creates a new lead
   * when no match exists (core fields required only then). Per-row validation
   * — a single bad row never rejects the whole file.
   */
  private buildUpdateWindows(raw?: string | null, updateKeyLens: Set<number> = new Set()) {
    const out = new Set<string>();
    for (const run of (raw ?? '').match(/\d+/g) ?? []) {
      for (const len of updateKeyLens) {
        for (let i = 0; i + len <= run.length; i++) out.add(run.slice(i, i + len));
      }
    }
    return out;
  }

  /**
   * Flag which import rows duplicate an existing lead or an earlier row in the
   * same file. A row is a duplicate when its Phone or its Email matches
   * EXACTLY — either one on its own is enough — and, where the options ask for
   * them, on the company domain or on the location.
   *
   * Company name ALONE is deliberately not compared, and nothing here scores
   * partial or percentage similarity. A name-shaped guess is what makes an
   * import review argue with the person reading it, over franchise branches and
   * common trading names that were never the same firm. The location rule is
   * the answer to that rather than a retreat from it: the name only counts when
   * the city and the state agree with it too, which is what tells one branch
   * from another.
   *
   * Used both by the pre-import check (so the user is warned before anything is
   * written) and by the import itself when "skip duplicates" is chosen, so the
   * two can never disagree about what a duplicate is.
   */
  async analyzeImport(rows: CreateLeadDto[], opts: LeadMatchOptions = {}) {
    // One definition of a match, shared with the Duplicate Leads screen. See
    // lead-dedupe.ts — the rule does not live here.
    const keysOf = (rec: MatchableRecord) => buildMatchKeys(rec, opts);

    /**
     * The key the import's own create-or-update lookup searches on: the last 10
     * digits of the row's phone. Kept identical to `bulkImport`'s, because the
     * whole point of predicting the outcome is that the prediction and the write
     * agree.
     */
    const rowUpdateKey = (r: CreateLeadDto) => {
      const d = (r.phone ?? '').replace(/\D/g, '');
      return d ? d.slice(-10) : '';
    };
    const wantUpdateKeys = new Set(rows.map(rowUpdateKey).filter(Boolean));
    const updateKeyLens = new Set([...wantUpdateKeys].map((k) => k.length));
    /**
     * Every digit window a stored number could be FOUND by, which is what makes
     * the outcome predictable in one pass instead of a query per row.
     *
     * That lookup is `phone contains <the row's last 10 digits>` against the RAW
     * stored text, so windows are taken from the raw string's digit runs: a lead
     * stored as "(305) 555-1234" yields none at all, because its digits are
     * broken up by punctuation and no ten-digit key can ever be a substring of
     * it. That is genuinely how the import behaves, and reproducing it is the
     * point — a kinder rule here would predict updates that never happen.
     */
    const updateWindows = (raw?: string | null) => this.buildUpdateWindows(raw, updateKeyLens);

    // Keys this file actually asks about. Built first so the scan below can
    // throw away every lead that answers none of them, which is what keeps the
    // memory here proportional to the FILE rather than to the lead book.
    const rowKeys = rows.map(keysOf);
    const wantPhone = new Set<string>();
    const wantEmail = new Set<string>();
    const wantDomain = new Set<string>();
    const wantLocation = new Set<string>();
    const wantLeadId = new Set<string>();
    for (const [i, k] of rowKeys.entries()) {
      for (const ph of k.phone) wantPhone.add(ph);
      if (k.email) wantEmail.add(k.email);
      for (const d of k.domain) wantDomain.add(d);
      if (k.location) wantLocation.add(k.location);
      if (rows[i].leadId) wantLeadId.add(rows[i].leadId!);
    }

    /**
     * The stored lead as the review needs it: enough to NAME the record it
     * matched, and enough to diff every column an import can write, so a row
     * that will update one can be merged field by field instead of the file
     * silently winning every column it happens to fill.
     */
    type Match = {
      id: string; leadId: string; businessName: string; phone: string; altPhone: string | null;
      email: string | null; website: string | null; assignedTo: string | null; assignedToId: string | null;
      createdAt: Date; leadGenerationId: string | null; leadSource: string | null; contactName: string | null;
      contactName2: string | null; socialMedia: string | null; country: string | null; state: string | null;
      city: string | null; timezone: string | null; industry: string | null; companySize: string | null;
      foundedYear: string | null; address: string | null; callStatus: string | null; lostReason: string | null;
      status: string;
    };
    const MATCH_SELECT = {
      id: true, leadId: true, businessName: true, phone: true, altPhone: true, email: true,
      website: true, createdAt: true, assignedToId: true, assignedTo: { select: { name: true } },
      leadGenerationId: true, leadSource: true, contactName: true, contactName2: true,
      socialMedia: true, country: true, state: true, city: true, timezone: true, industry: true,
      companySize: true, foundedYear: true, address: true, callStatus: true, lostReason: true,
      status: true,
    } as const;
    const toMatch = (l: Record<string, unknown>): Match => ({
      id: l.id as string,
      leadId: l.leadId as string,
      businessName: l.businessName as string,
      phone: l.phone as string,
      altPhone: (l.altPhone ?? null) as string | null,
      email: (l.email ?? null) as string | null,
      website: (l.website ?? null) as string | null,
      assignedTo: ((l.assignedTo as { name?: string } | null)?.name ?? null) as string | null,
      assignedToId: (l.assignedToId ?? null) as string | null,
      createdAt: l.createdAt as Date,
      leadGenerationId: (l.leadGenerationId ?? null) as string | null,
      leadSource: (l.leadSource ?? null) as string | null,
      contactName: (l.contactName ?? null) as string | null,
      contactName2: (l.contactName2 ?? null) as string | null,
      socialMedia: (l.socialMedia ?? null) as string | null,
      country: (l.country ?? null) as string | null,
      state: (l.state ?? null) as string | null,
      city: (l.city ?? null) as string | null,
      timezone: (l.timezone ?? null) as string | null,
      industry: (l.industry ?? null) as string | null,
      companySize: (l.companySize ?? null) as string | null,
      foundedYear: (l.foundedYear ?? null) as string | null,
      address: (l.address ?? null) as string | null,
      callStatus: (l.callStatus ?? null) as string | null,
      lostReason: (l.lostReason ?? null) as string | null,
      status: l.status as string,
    });
    const exPhone = new Map<string, Match>();
    const exEmail = new Map<string, Match>();
    const exDomain = new Map<string, Match>();
    const exLocation = new Map<string, Match>();
    const exLeadId = new Map<string, Match>();
    const exUpdate = new Map<string, Match>();

    /**
     * The lead book, walked in pages by primary key rather than pulled down in
     * one `take: 50_000`.
     *
     * That cap was a silent correctness hole: past fifty thousand leads the rows
     * beyond it simply weren't compared, so an import could be told it held no
     * duplicates by a check that had never looked at the lead it duplicated. A
     * cursor has no such edge. Only the leads that answer one of this file's
     * keys are kept, so the paging bounds the memory the cap was there to bound.
     */
    const PAGE = 5_000;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.lead.findMany({
        where: { deletedAt: null },
        select: MATCH_SELECT,
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (page.length === 0) break;

      for (const l of page) {
        // The company name rides along for the review, which has to NAME the
        // lead it matched. It has a say in whether they matched only under the
        // location rule, and only alongside the city and the state.
        const m = toMatch(l);
        const k = keysOf(l);
        for (const ph of k.phone) {
          if (wantPhone.has(ph) && !exPhone.has(ph)) exPhone.set(ph, m);
        }
        if (k.email && wantEmail.has(k.email) && !exEmail.has(k.email)) exEmail.set(k.email, m);
        for (const d of k.domain) {
          if (wantDomain.has(d) && !exDomain.has(d)) exDomain.set(d, m);
        }
        if (k.location && wantLocation.has(k.location) && !exLocation.has(k.location)) {
          exLocation.set(k.location, m);
        }
        if (wantLeadId.has(l.leadId) && !exLeadId.has(l.leadId)) exLeadId.set(l.leadId, m);
        for (const w of updateWindows(l.phone)) {
          if (wantUpdateKeys.has(w) && !exUpdate.has(w)) exUpdate.set(w, m);
        }
      }

      if (page.length < PAGE) break;
      cursor = page[page.length - 1].id;
    }

    // Within-file repeats: a key already seen in an EARLIER row of the same upload.
    const seenPhone = new Set<string>();
    const seenEmail = new Set<string>();
    const seenDomain = new Set<string>();
    const seenLocation = new Set<string>();
    const perRow = rows.map((r, index) => {
      const k = rowKeys[index];
      const on: MatchSignal[] = [];
      // Every DISTINCT lead this row collides with, keyed by lead id. A row can
      // hit one lead on its phone and a different one on its email, and naming
      // only the first has the user decide against half the picture.
      const matches = new Map<string, Match>();
      let phoneHit = false;
      for (const ph of k.phone) {
        const ex = exPhone.get(ph);
        if (ex) matches.set(ex.leadId, ex);
        if (ex || seenPhone.has(ph)) phoneHit = true;
      }
      if (phoneHit) on.push('Phone');
      if (k.email && (exEmail.has(k.email) || seenEmail.has(k.email))) {
        on.push('Email');
        const ex = exEmail.get(k.email);
        if (ex) matches.set(ex.leadId, ex);
      }
      let domainHit = false;
      for (const d of k.domain) {
        const ex = exDomain.get(d);
        if (ex) matches.set(ex.leadId, ex);
        if (ex || seenDomain.has(d)) domainHit = true;
      }
      if (domainHit) on.push('Company Domain');
      if (k.location && (exLocation.has(k.location) || seenLocation.has(k.location))) {
        on.push('Location');
        const ex = exLocation.get(k.location);
        if (ex) matches.set(ex.leadId, ex);
      }
      for (const ph of k.phone) seenPhone.add(ph);
      if (k.email) seenEmail.add(k.email);
      for (const d of k.domain) seenDomain.add(d);
      if (k.location) seenLocation.add(k.location);

      /**
       * What importing this row would actually DO, which is not the same
       * question as whether it is a duplicate and had no answer on screen at
       * all. A row matching an existing lead by id or phone updates that lead;
       * anything else creates one. So a row can be flagged as a duplicate on
       * its email and still create a SECOND lead, and a row nobody flagged can
       * quietly update an existing one — both surprises the review can now say
       * out loud before the user decides.
       *
       * Predicted against the book as it stands. Rows earlier in this same file
       * can create leads that later rows then update, but whether they do
       * depends on the skip decisions the user has not made yet, so this does
       * not guess at them.
       */
      const uk = rowUpdateKey(r);
      const willUpdate = (r.leadId ? exLeadId.get(r.leadId) : undefined) ?? (uk ? exUpdate.get(uk) : undefined) ?? null;

      return {
        index,
        duplicate: on.length > 0,
        matchedOn: on,
        // The import row's own key fields, for the left side of the review grid.
        row: { businessName: r.businessName ?? '', phone: r.phone ?? '', email: r.email ?? '' },
        // The CRM lead(s) it clashed with. Empty when the row only repeats an
        // earlier row of the same file, which has no saved lead to point at.
        existing: [...matches.values()],
        // The lead this row would be written INTO, or null if it would create
        // one. Carries the full record so the review can offer a field-by-field
        // merge against it rather than just naming it.
        willUpdate,
        // What this row is filed under when a decision about it is remembered.
        decisionKey: decisionKey(r),
      };
    });

    const duplicateRecords = perRow.filter((r) => r.duplicate).length;
    const willUpdateRecords = perRow.filter((r) => r.willUpdate).length;
    return {
      total: rows.length,
      duplicateRecords,
      newRecords: rows.length - duplicateRecords,
      // Create-or-update split for the whole file, duplicates and clean rows
      // alike — the answer to "what is this import about to do to my book".
      willUpdateRecords,
      willCreateRecords: rows.length - willUpdateRecords,
      rows: perRow,
    };
  }

  async bulkImport(dto: ImportLeadsDto, userId?: string) {
    const errors: Array<{ row: number; reason: string }> = [];
    const callerCache = new Map<string, string | undefined>();
    const assignedTodayCache = new Map<string, boolean>();
    const importLeadCache = new Map<string, ImportLeadMatch>();
    let imported = 0;
    let updated = 0;
    // Assignment outcome per row, reported alongside the create/update counts so a
    // batch that imported cleanly but failed to assign is visible rather than
    // looking like a success.
    let assignOk = 0;
    let assignFailed = 0;
    // Ids of leads this import CREATED (not ones it merely updated). Returned so
    // the import can be rolled back to exactly this batch — deleting these leaves
    // every pre-existing lead the import touched untouched.
    const createdIds: string[] = [];

    const resolveAssigned = async (caller?: string) => {
      const key = caller?.trim().toLowerCase();
      if (!key) return undefined;
      if (!callerCache.has(key)) callerCache.set(key, await this.resolveCaller(caller));
      return callerCache.get(key);
    };

    const assignedTodayCached = async (leadId: string) => {
      if (!assignedTodayCache.has(leadId)) assignedTodayCache.set(leadId, await this.assignedToday(leadId));
      return assignedTodayCache.get(leadId)!;
    };

    // Duplicate flags for the whole file, under the same settings the user was
    // shown the review under — a rule the check and the write disagreed on is a
    // row skipped for a reason nobody was told.
    const analysis = await this.analyzeImport(dto.rows, {
      checkFields: dto.checkFields,
      ignorePhoneFormatting: dto.ignorePhoneFormatting,
      matchCompanyDomain: dto.matchCompanyDomain,
      matchLocation: dto.matchLocation,
    });
    const dupByIndex = analysis.rows;
    const skipRowSet = new Set(dto.skipRowIndexes ?? []);
    let duplicateRecords = 0;
    let skipped = 0;
    // What the reviewer chose about each duplicate, to be remembered once the
    // import has actually run. Collected rather than written per row so a file
    // of thousands costs one write instead of thousands.
    const decisions = new Map<string, 'import' | 'skip'>();

    for (let i = 0; i < dto.rows.length; i++) {
      const row = dto.rows[i];
      const n = i + 1;
      const phoneKey = (row.phone ?? '').replace(/\D/g, '');
      const last10 = phoneKey.slice(-10);

      const isDuplicate = dupByIndex[i]?.duplicate ?? false;
      if (isDuplicate) {
        duplicateRecords++;
        const shouldSkip = dto.skipDuplicates || skipRowSet.has(i);
        const dk = dupByIndex[i].decisionKey;
        if (dk) decisions.set(dk, shouldSkip ? 'skip' : 'import');
        if (shouldSkip) {
          skipped++;
          errors.push({ row: n, reason: `Skipped duplicate (matched on ${dupByIndex[i].matchedOn.join(', ')})` });
          continue;
        }
      } else if (skipRowSet.has(i)) {
        skipped++;
        errors.push({ row: n, reason: 'Skipped by user choice' });
        continue;
      }
      // No second same-file phone guard here. It compared digits only, so under
      // an exact-match rule it silently skipped rows the review screen had just
      // reported as clean — "3055551234" dropped because an earlier row wrote
      // "+13055551234". Two rows carrying the same number in different formats
      // now both run, and the second is picked up by the create-or-update lookup
      // below and applied to the lead the first one made, which is reported as
      // an update rather than disappearing into the error list.

      // Only the provided (non-empty) columns; missing columns stay untouched.
      const data: Prisma.LeadUpdateInput = {};
      const setIf = (key: keyof Prisma.LeadUpdateInput, v?: string) => {
        if (v != null && String(v).trim() !== '') (data as Record<string, unknown>)[key] = String(v).trim();
      };
      setIf('businessName', row.businessName);
      setIf('phone', row.phone);
      setIf('email', row.email);
      setIf('state', row.state);
      setIf('city', row.city);
      // Normalize + validate enums so a stray value can never crash the import.
      const tz = (row.timezone ?? '').trim().toUpperCase();
      if ((Object.values(Timezone) as string[]).includes(tz)) data.timezone = tz as Timezone;
      const stRaw = (row.status ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
      const stAlias: Record<string, string> = { closed_won: 'closed', won: 'closed', lost: 'rejected', new_lead: 'new' };
      const st = stAlias[stRaw] ?? stRaw;
      if ((Object.values(LeadStatus) as string[]).includes(st)) data.status = st as LeadStatus;
      setIf('contactName', row.contactName);
      setIf('industry', row.industry);
      setIf('title', row.title);
      setIf('employeeCode', row.employeeCode);
      setIf('comments', row.comments);
      setIf('leadCategory', row.leadCategory);
      setIf('callStatus', row.callStatus);
      setIf('lostReason', row.lostReason);
      setIf('leadGenerationId', row.leadGenerationId);
      setIf('leadSource', row.leadSource);
      setIf('contactName2', row.contactName2);
      setIf('altPhone', row.altPhone);
      setIf('website', row.website);
      setIf('socialMedia', row.socialMedia);
      setIf('country', row.country);
      setIf('companySize', row.companySize);
      setIf('foundedYear', row.foundedYear);
      setIf('address', row.address);
      const fu = row.nextFollowUpDate ? new Date(row.nextFollowUpDate) : undefined;
      if (fu && !isNaN(fu.getTime())) data.nextFollowUpDate = fu;
      const fc = row.firstContact ? new Date(row.firstContact) : undefined;
      if (fc && !isNaN(fc.getTime())) data.firstContact = fc;
      const lc = row.lastContact ? new Date(row.lastContact) : undefined;
      if (lc && !isNaN(lc.getTime())) data.lastContact = lc;
      const md = row.meetingDate ? new Date(row.meetingDate) : undefined;
      if (md && !isNaN(md.getTime())) data.meetingDate = md;
      if (row.followupCount != null) data.followupCount = Number(row.followupCount);
      // Skip completely empty rows (nothing provided at all).
      if (Object.keys(data).length === 0 && !row.caller?.trim()) continue;

      // ── Auto-assignment from the sheet's "Assigned To" column ──
      // A named employee that can't be matched is a data error worth surfacing:
      // silently importing the lead unassigned is how a whole batch ends up
      // needing manual assignment afterwards, which is exactly what this avoids.
      const callerCell = row.caller?.trim();
      const assignedToId = await resolveAssigned(row.caller);
      if (callerCell && !assignedToId) {
        errors.push({ row: n, reason: `Employee '${callerCell}' was not found. Please verify the Assigned To value.` });
        assignFailed++;
      }
      const assignRel = assignedToId ? { assignedTo: { connect: { id: assignedToId } } } : {};

      // Match an existing lead by leadId or phone (last 10 digits), if any.
      let existing: ImportLeadMatch | null = null;
      const preKnownExisting = dupByIndex[i]?.willUpdate ?? null;
      if (preKnownExisting) {
        existing = {
          ...preKnownExisting,
          assignedTo: preKnownExisting.assignedTo ?? null,
          assignedToId: preKnownExisting.assignedToId ?? null,
        };
      } else if (row.leadId) {
        const leadKey = `lead:${row.leadId}`;
        existing = importLeadCache.get(leadKey) ?? null;
      }
      if (!existing && last10) {
        const phoneKeyCache = `phone:${last10}`;
        existing = importLeadCache.get(phoneKeyCache) ?? null;
      }
      if (!existing && (last10 || row.leadId)) {
        existing = await this.prisma.lead.findFirst({
          where: {
            deletedAt: null,
            OR: [...(row.leadId ? [{ leadId: row.leadId }] : []), ...(last10 ? [{ phone: { contains: last10 } }] : [])],
          },
          select: { id: true, leadId: true, businessName: true, phone: true, altPhone: true, email: true,
            website: true, createdAt: true, assignedToId: true, assignedTo: { select: { name: true } },
            leadGenerationId: true, leadSource: true, contactName: true, contactName2: true,
            socialMedia: true, country: true, state: true, city: true, timezone: true, industry: true,
            companySize: true, foundedYear: true, address: true, callStatus: true, lostReason: true,
            status: true },
        }) as ImportLeadMatch | null;
        if (existing) {
          const cacheKey = row.leadId ? `lead:${row.leadId}` : `phone:${last10}`;
          importLeadCache.set(cacheKey, existing);
        }
      }

      if (existing) {
        // A lead has exactly one owner, so an import must not take one off the
        // employee already holding it — the sheet updates the lead's fields, but
        // ownership stays put and the clash is reported.
        const ownedByOther = !!existing.assignedToId && !!assignedToId && existing.assignedToId !== assignedToId;
        if (ownedByOther) {
          errors.push({
            row: n,
            reason: `Already assigned to ${existing.assignedTo ?? 'another employee'} — ownership left unchanged.`,
          });
          assignFailed++;
        } else if (assignedToId) {
          assignOk++;
        }
        // The daily restriction, as it applies to an import: a lead handed over
        // earlier today keeps its owner even if the sheet names someone else, so
        // a re-import can't shuffle ownership mid-day.
        //
        // No confirmation path here, unlike the interactive routes. A file of a
        // few thousand rows is not something a manager can meaningfully confirm
        // lead by lead, and one blanket "yes" over a whole import is exactly the
        // accident the restriction exists to prevent. The row is reported and
        // ownership left alone; reassigning is then a deliberate act in the UI.
        const lockedToday = !ownedByOther && !!assignedToId && existing.assignedToId !== assignedToId && (await assignedTodayCached(existing.id));
        if (lockedToday) {
          errors.push({
            row: n,
            reason: 'Already assigned today — ownership left unchanged. Reassign from Lead Management if this is intended.',
          });
          assignFailed++;
        }
        const keepOwner = ownedByOther || lockedToday ? {} : assignRel;
        const changedOwner = !ownedByOther && !lockedToday && !!assignedToId && existing.assignedToId !== assignedToId;
        // An imported row that closes (or reopens) a lead is credited to the
        // row's CALLER — the rep the sheet names — never to whoever ran the
        // import.
        const closure = closureFields(data.status as LeadStatus | undefined, existing.status as LeadStatus | undefined, assignedToId ?? null);
        const updatedLead = await this.prisma.lead.update({ where: { id: existing.id }, data: { ...data, ...keepOwner, ...closure } });
        if (userId) await this.log(updatedLead.id, userId, 'lead_updated', null, null, 'Imported row updated lead');
        // Record the handover so the daily restriction applies to it from here
        // on. The previous owner is passed explicitly: the update above has
        // already put the new one on the lead, so reading it back would record
        // the handover as having come from the person it went to.
        if (changedOwner && userId) {
          await this.recordAssignment(existing.id, assignedToId!, userId, 'Excel import', {
            previousCallerId: existing.assignedToId ?? null,
          });
        }
        updated++;
      } else {
        // No required columns: missing core fields default to empty (fill later).
        const created = await this.createLead(
          (leadId) =>
            ({
              leadId,
              businessName: '',
              phone: '',
              state: '',
              city: '',
              // No `timezone` fallback on purpose. Stamping EST here is how a
              // row with a blank or unreadable zone became a lead that claimed
              // to be Eastern, and callbacks against it were booked on the
              // wrong clock. Left null, the lead reads as unconfigured and the
              // scheduler asks for a zone before it will book anything.
              status: LeadStatus.new,
              ...data,
              ...assignRel,
              ...closureCreateFields(data.status as LeadStatus | undefined, assignedToId ?? null),
            }) as Prisma.LeadCreateInput,
          row.leadId,
        );
        if (userId) await this.log(created.id, userId, 'lead_created', null, created.status, 'Imported row created lead');
        imported++;
        createdIds.push(created.id);
        if (row.leadId) importLeadCache.set(`lead:${row.leadId}`, { id: created.id, leadId: created.leadId, businessName: '', phone: '', altPhone: null, email: null, website: null, assignedTo: null, assignedToId: assignedToId ?? null, createdAt: new Date(), leadGenerationId: null, leadSource: null, contactName: null, contactName2: null, socialMedia: null, country: null, state: '', city: '', timezone: null, industry: null, companySize: null, foundedYear: null, address: null, callStatus: null, lostReason: null, status: created.status });
        if (last10) importLeadCache.set(`phone:${last10}`, { id: created.id, leadId: created.leadId, businessName: '', phone: '', altPhone: null, email: null, website: null, assignedTo: null, assignedToId: assignedToId ?? null, createdAt: new Date(), leadGenerationId: null, leadSource: null, contactName: null, contactName2: null, socialMedia: null, country: null, state: '', city: '', timezone: null, industry: null, companySize: null, foundedYear: null, address: null, callStatus: null, lostReason: null, status: created.status });
        // A brand-new lead has no prior owner, so the sheet's employee always wins.
        if (assignedToId) {
          assignOk++;
          if (userId) await this.recordAssignment(created.id, assignedToId, userId, 'Excel import', { previousCallerId: null });
        }
      }
    }

    /**
     * Remember what was ruled, so the next run of the same file does not ask
     * again. Upserted one key at a time inside a transaction — `createMany` with
     * skipDuplicates would keep the OLD answer for a key already on file, and a
     * decision the user has just changed is precisely the one worth keeping.
     *
     * Deliberately after the import, and deliberately not fatal: a decision that
     * fails to save costs one repeated question next time, and is not a reason
     * to report a completed import as failed.
     */
    if (decisions.size > 0) {
      try {
        await this.prisma.$transaction(
          [...decisions].map(([matchKey, decision]) =>
            this.prisma.importDuplicateDecision.upsert({
              where: { matchKey },
              create: { matchKey, decision, decidedById: userId ?? null },
              update: { decision, decidedById: userId ?? null, decidedAt: new Date() },
            }),
          ),
        );
      } catch {
        // Left unlogged-through rather than thrown: see above.
      }
    }

    // NTF-003 — alert managers that a new batch landed
    if (imported > 0) {
      await this.notifications.notifyManagers(
        'new_leads',
        'New leads uploaded',
        `${imported} new lead(s) were imported.`,
      );
    }

    return {
      imported,
      updated,
      skipped,
      errors,
      totalRows: dto.rows.length,
      // Duplicate summary (requirement 15): Total / New / Duplicate / Imported /
      // Skipped. "Imported" is create + update; "duplicateRecords" is what matched
      // an existing lead or an earlier row, whether or not they were skipped.
      newRecords: dto.rows.length - duplicateRecords,
      duplicateRecords,
      successfullyImported: imported + updated,
      createdIds,
      assignedSuccessfully: assignOk,
      assignmentFailed: assignFailed,
    };
  }

  /**
   * Leads that duplicate ONE record, for the paths that create leads one at a
   * time — the New Lead form, and anything else that mints a lead by hand.
   *
   * The import was the only door that checked. A lead typed into the form went
   * in unchecked, so the book steadily collected exactly the duplicates the
   * import screen exists to prevent, and someone had to find them later on the
   * Duplicate Leads screen. Same rule as both, out of lead-dedupe.ts.
   *
   * Narrowed in SQL, decided in TypeScript. The address rule folds +tags and
   * Gmail dots, and writing that a second time in SQL is how two copies drift
   * into disagreeing about who is a duplicate — so the query narrows by EMAIL
   * DOMAIN, which survives the folding untouched and is therefore a strict
   * superset, and `buildMatchKeys` decides among the candidates. Indexes for
   * both halves land in 20260806100000.
   */
  async findDuplicatesFor(
    rec: MatchableRecord & { excludeId?: string },
    opts: LeadMatchOptions = {},
  ) {
    const keys = buildMatchKeys(rec, opts);
    const domains = [...keys.domain];
    // The domain to narrow the email search by is the raw one, which exists even
    // when the address belongs to a mailbox provider — `keys.domain` has those
    // stripped out because they say nothing about which COMPANY someone is at.
    const rawDomain = emailDomain(rec.email);

    const phoneList = [...keys.phone];
    if (phoneList.length === 0 && !rawDomain && domains.length === 0 && !keys.location) return [];

    const or: Prisma.LeadWhereInput[] = [];
    if (phoneList.length) {
      if (opts.ignorePhoneFormatting) {
        // Looser mode compares digits, which no btree can answer — the digits
        // trigram indexes from 20260729120000 serve this.
        for (const p of phoneList) {
          or.push({ phone: { contains: p } }, { altPhone: { contains: p } });
        }
      } else {
        or.push({ phone: { in: phoneList } }, { altPhone: { in: phoneList } });
      }
    }
    // `endsWith` on the domain, which the expression index answers.
    for (const d of new Set([rawDomain, ...domains].filter(Boolean))) {
      or.push({ email: { endsWith: `@${d}`, mode: 'insensitive' } });
    }
    // Location, narrowed the same way the email is: by something the folding
    // cannot alter. Both `contains` terms are strict supersets of the compare
    // (see longestWord), so this can only widen the candidate set, and the
    // business-name trigram index from 20260729120000 answers it. The state is
    // NOT narrowed on — "Florida" folds to "fl", which no SQL term here knows.
    if (keys.location) {
      const nameWord = longestWord(rec.businessName);
      const cityWord = longestWord(rec.city);
      if (nameWord && cityWord) {
        or.push({
          AND: [
            { businessName: { contains: nameWord, mode: 'insensitive' } },
            { city: { contains: cityWord, mode: 'insensitive' } },
          ],
        });
      }
    }
    if (or.length === 0) return [];

    const candidates = await this.prisma.lead.findMany({
      where: {
        deletedAt: null,
        ...(rec.excludeId ? { id: { not: rec.excludeId } } : {}),
        OR: or,
      },
      select: {
        id: true, leadId: true, businessName: true, phone: true, altPhone: true, email: true,
        website: true, city: true, state: true, status: true, createdAt: true,
        assignedTo: { select: { name: true } },
      },
      // A wide net on a common domain still has to end somewhere; the narrowing
      // above is a superset, so this only bounds how much of it is examined.
      take: 500,
    });

    const out: Array<{
      id: string; leadId: string; businessName: string; phone: string; altPhone: string | null;
      email: string | null; website: string | null; status: string;
      assignedTo: string | null; createdAt: Date; matchedOn: MatchSignal[];
    }> = [];
    for (const c of candidates) {
      const ck = buildMatchKeys(c, opts);
      const on: MatchSignal[] = [];
      if ([...keys.phone].some((p) => ck.phone.has(p))) on.push('Phone');
      if (keys.email && ck.email === keys.email) on.push('Email');
      if ([...keys.domain].some((d) => ck.domain.has(d))) on.push('Company Domain');
      if (keys.location && ck.location === keys.location) on.push('Location');
      if (on.length) {
        out.push({
          id: c.id, leadId: c.leadId, businessName: c.businessName, phone: c.phone,
          altPhone: c.altPhone, email: c.email, website: c.website, status: c.status,
          assignedTo: c.assignedTo?.name ?? null, createdAt: c.createdAt, matchedOn: on,
        });
      }
    }
    return out;
  }

  /**
   * Duplicate groups across the leads already in the CRM — the scan behind the
   * Duplicate Leads screen.
   *
   * The import only ever protects the front door. Leads also arrive by hand and
   * off inbound calls, so a book collects duplicates the import never saw, and
   * the Admin panel has advertised a "Purge Duplicates" tool for a while with
   * nothing behind it. Same rule as the import, out of lead-dedupe.ts.
   *
   * Grouping is transitive: if A shares a phone with B and B shares an email
   * with C, all three are one group. Two leads that reach the same company are
   * one problem to settle, not two pairs to settle twice.
   */
  async findDuplicateGroups(opts: LeadMatchOptions & { limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

    type Row = {
      id: string; leadId: string; businessName: string; phone: string; altPhone: string | null;
      email: string | null; website: string | null; contactName: string | null; city: string | null;
      state: string | null; timezone: string | null; industry: string | null; status: string;
      createdAt: Date; assignedTo: { name: string } | null;
    };
    const leads: Row[] = [];

    // Same paging as the import scan, and for the same reason: no cap that
    // quietly stops looking part-way through the book.
    const PAGE = 5_000;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.lead.findMany({
        where: { deletedAt: null },
        select: {
          id: true, leadId: true, businessName: true, phone: true, altPhone: true, email: true,
          website: true, contactName: true, city: true, state: true, timezone: true, industry: true,
          status: true, createdAt: true, assignedTo: { select: { name: true } },
        },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (page.length === 0) break;
      leads.push(...(page as Row[]));
      if (page.length < PAGE) break;
      cursor = page[page.length - 1].id;
    }

    // Union-find over lead positions: every shared key merges two sets, so a
    // chain of pairwise matches settles into one group in a single pass.
    const parent = leads.map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    const union = (a: number, b: number) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };

    const keys = leads.map((l) => buildMatchKeys(l, opts));
    const firstSeen = new Map<string, number>();
    const link = (key: string, i: number) => {
      const prev = firstSeen.get(key);
      if (prev === undefined) firstSeen.set(key, i);
      else union(prev, i);
    };
    for (const [i, k] of keys.entries()) {
      for (const ph of k.phone) link(`p:${ph}`, i);
      if (k.email) link(`e:${k.email}`, i);
      for (const d of k.domain) link(`d:${d}`, i);
      if (k.location) link(`l:${k.location}`, i);
    }

    const byRoot = new Map<number, number[]>();
    for (let i = 0; i < leads.length; i++) {
      const r = find(i);
      const bucket = byRoot.get(r);
      if (bucket) bucket.push(i);
      else byRoot.set(r, [i]);
    }

    const filled = (l: Row) =>
      COMPLETENESS_FIELDS.filter((f) => String((l as unknown as Record<string, unknown>)[f] ?? '').trim() !== '').length;

    const groups = [...byRoot.values()]
      .filter((members) => members.length > 1)
      .map((members) => {
        // Which signals actually bind THIS group, worked out from the members
        // rather than remembered from the union that merged them — a group of
        // three can be held together by a phone and an email at once.
        const signals = new Set<MatchSignal>();
        const count = (vals: string[]) => {
          const seen = new Set<string>();
          for (const v of vals) { if (seen.has(v)) return true; seen.add(v); }
          return false;
        };
        if (count(members.flatMap((i) => [...keys[i].phone]))) signals.add('Phone');
        if (count(members.map((i) => keys[i].email).filter(Boolean))) signals.add('Email');
        if (count(members.flatMap((i) => [...keys[i].domain]))) signals.add('Company Domain');
        if (count(members.map((i) => keys[i].location).filter(Boolean))) signals.add('Location');

        // Oldest first, then most complete: the record most likely worth keeping
        // leads the group, but the screen never decides on the user's behalf.
        const sorted = [...members].sort(
          (a, b) =>
            leads[a].createdAt.getTime() - leads[b].createdAt.getTime() ||
            filled(leads[b]) - filled(leads[a]),
        );
        return {
          size: members.length,
          matchedOn: [...signals],
          leads: sorted.map((i) => ({
            id: leads[i].id,
            leadId: leads[i].leadId,
            businessName: leads[i].businessName,
            phone: leads[i].phone,
            altPhone: leads[i].altPhone,
            email: leads[i].email,
            website: leads[i].website,
            contactName: leads[i].contactName,
            city: leads[i].city,
            state: leads[i].state,
            status: leads[i].status,
            assignedTo: leads[i].assignedTo?.name ?? null,
            createdAt: leads[i].createdAt,
            /** How many key columns this record actually fills in. */
            filled: filled(leads[i]),
          })),
        };
      })
      .sort((a, b) => b.size - a.size || a.leads[0].leadId.localeCompare(b.leads[0].leadId));

    return {
      scanned: leads.length,
      totalGroups: groups.length,
      // What removing every group down to one record each would clear.
      redundantLeads: groups.reduce((n, g) => n + g.size - 1, 0),
      returned: Math.min(groups.length, limit),
      groups: groups.slice(0, limit),
    };
  }

  /** Pre-import scan: how many rows are new vs duplicate, what the import would
   *  create vs update, and which rows need a decision. */
  async checkImport(rows: CreateLeadDto[], opts: LeadMatchOptions = {}) {
    const a = await this.analyzeImport(rows, opts);
    const duplicateRows = a.rows.filter((r) => r.duplicate);

    /**
     * What was decided about these same rows last time.
     *
     * Reviewing a file and ruling on its duplicates was worth nothing the second
     * time: re-running it asked every question again, with no sign the answer
     * had already been given. Prior rulings come back with the row so the review
     * can pre-set the toggle and say WHY it is pre-set — the user can still
     * change it, and changing it is what gets remembered next.
     */
    const keys = [...new Set(duplicateRows.map((r) => r.decisionKey).filter(Boolean))];
    const priors = keys.length
      ? await this.prisma.importDuplicateDecision.findMany({
          where: { matchKey: { in: keys } },
          select: { matchKey: true, decision: true, decidedAt: true, decidedBy: { select: { name: true } } },
        })
      : [];
    const priorByKey = new Map(priors.map((p) => [p.matchKey, p]));

    return {
      total: a.total,
      newRecords: a.newRecords,
      duplicateRecords: a.duplicateRecords,
      willUpdateRecords: a.willUpdateRecords,
      willCreateRecords: a.willCreateRecords,
      decidedBefore: duplicateRows.filter((r) => priorByKey.has(r.decisionKey)).length,
      // Only the duplicate rows, so the client can highlight them without shipping
      // a flag for every single row.
      duplicateRows: duplicateRows.map((r) => {
        const p = priorByKey.get(r.decisionKey);
        return {
          ...r,
          priorDecision: p
            ? { decision: p.decision, decidedAt: p.decidedAt, decidedBy: p.decidedBy?.name ?? null }
            : null,
        };
      }),
    };
  }

  async findAll(query: ListLeadsQueryDto, user?: { id: string; role: Role }) {
    // Closed Leads (`closed: true`) and Lead Management (`closed: false`) are
    // the same list split by status; omitting the flag returns both.
    const closedFilter =
      query.closed === true
        ? { status: LeadStatus.closed }
        : query.closed === false
          ? { status: { not: LeadStatus.closed } }
          : {};
    // RBAC: employees see only their own leads. In Closed Leads that means the
    // leads they personally closed, not the ones merely assigned to them —
    // closing is what earns visibility, and a lead can be reassigned after.
    // Admins & team leaders see every lead in either module, which is what lets
    // them select and distribute leads that belong to nobody yet.
    const scope =
      user?.role === Role.employee
        ? query.closed === true
          ? { closedById: user.id }
          : { assignedToId: user.id }
        : {};
    // `mine` narrows any role to their own book on request. It was declared on the
    // DTO but never read, so a manager asking for their own leads silently got
    // everyone's — the flag has to do what it says or not be offered.
    const mineScope = query.mine && user ? (query.closed === true ? { closedById: user.id } : { assignedToId: user.id }) : {};
    // Inclusive lead-id window for range assignment.
    //
    // Lead ids are `L-<year>-<n>` with NO zero padding, so comparing them as
    // strings is wrong: "L-2026-10" sorts before "L-2026-2", and a 1→5 range would
    // drag in 10-21. The trailing sequence number is what has to be compared, so
    // the matching ids are resolved numerically first and the list is then scoped
    // to them.
    const ranged = !!(query.fromLeadId || query.toLeadId);
    let rangeFilter: Prisma.LeadWhereInput = {};
    if (ranged) {
      const parse = (v?: string) => {
        const m = v?.trim().match(/^(.*?)(\d+)$/);
        return m ? { prefix: m[1], num: Number(m[2]) } : null;
      };
      const from = parse(query.fromLeadId);
      const to = parse(query.toLeadId);
      const prefix = from?.prefix ?? to?.prefix;

      if (prefix !== undefined && (from || to)) {
        const lo = from?.num ?? Number.NEGATIVE_INFINITY;
        const hi = to?.num ?? Number.POSITIVE_INFINITY;
        // A range is scoped to the prefix it was typed with, because the
        // sequence restarts each year (see LeadIdService): the number 1240 names
        // one lead in 2026 and a different one in 2027, so a range that ignored
        // the prefix would sweep up a lead per year for every number in it.
        //
        // The prefix comes from the `from` endpoint, or from `to` when only that
        // was given — the two are expected to share one, since a range across a
        // year boundary is not a contiguous block of leads under this scheme.
        const candidates = await this.prisma.lead.findMany({
          where: { deletedAt: null, leadId: { startsWith: prefix } },
          select: { id: true, leadId: true },
        });
        const ids = candidates
          .filter((c) => {
            const m = c.leadId.slice(prefix.length).match(/^(\d+)$/);
            if (!m) return false; // ids that don't fit the sequence shape aren't in any range
            const n = Number(m[1]);
            return n >= lo && n <= hi;
          })
          .map((c) => c.id);
        rangeFilter = { id: { in: ids } };
      } else {
        // Endpoints that carry no trailing number (an id imported in some other
        // shape) fall back to a plain string window.
        rangeFilter = {
          leadId: {
            ...(query.fromLeadId ? { gte: query.fromLeadId } : {}),
            ...(query.toLeadId ? { lte: query.toLeadId } : {}),
          },
        };
      }
    }
    // Free-text lookup for the command palette.
    const term = query.q?.trim();
    const digits = term?.replace(/\D/g, '') ?? '';

    // Phone needs formatting stripped from BOTH sides. Numbers are stored however
    // the import wrote them — "+1 (305) 555-1234" here, "+14155559876" there — so
    // a plain `contains` on the typed digits finds the second and misses the
    // first, which is the more common shape. Comparing digits-to-digits in SQL
    // means "(305) 555-1234", "305 555 1234" and "3055551234" all find the same
    // lead whichever way it happens to be stored. Bounded, and only run when the
    // term looks like part of a number at all.
    let phoneMatches: string[] = [];
    if (digits.length >= 3) {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM leads
        WHERE deleted_at IS NULL
          AND (
            regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ${`%${digits}%`}
            OR regexp_replace(COALESCE(alt_phone, ''), '[^0-9]', '', 'g') LIKE ${`%${digits}%`}
          )
        LIMIT 200
      `);
      phoneMatches = rows.map((r) => r.id);
    }

    const searchFilter: Prisma.LeadWhereInput = term
      ? {
          OR: [
            { businessName: { contains: term, mode: 'insensitive' } },
            { contactName: { contains: term, mode: 'insensitive' } },
            { email: { contains: term, mode: 'insensitive' } },
            { leadId: { contains: term, mode: 'insensitive' } },
            ...(phoneMatches.length ? [{ id: { in: phoneMatches } }] : []),
          ],
        }
      : {};

    // The filters the grid used to apply in the browser, over rows it had to
    // download first. Doing them here is what makes one page a correct page.
    const cityFilter = query.city ? { city: query.city } : {};
    const zoneFilter = timezoneWhere(query.timezone);
    // A lead dispositioned through the CRM stores the outcome's SLUG
    // (`call_back`); leads imported before the outcome list existed carry the
    // display NAME ("Call Back"). Both match, exactly as the browser filter did
    // — dropping the alias would silently stop matching every imported lead.
    const outcomeFilter = query.callStatus
      ? { callStatus: { in: await this.callStatusAliases(query.callStatus), mode: 'insensitive' as const } }
      : {};
    const assignedFilter =
      query.assigned === 'assigned' ? { assignedToId: { not: null } } : query.assigned === 'unassigned' ? { assignedToId: null } : {};
    /**
     * The date range, applied to whichever of the module's two dates was asked
     * for.
     *
     * `created` (the default, and what every existing caller gets) reads
     * `createdAt` — when the lead was FIRST created, a stamp nothing rewrites.
     *
     * `scheduled` reads the active assignment instead — the day the lead is
     * currently on somebody's queue for. The two are the same day only until the
     * lead is reassigned or carried into a new day, and the difference is what
     * this option exists for: filtering "today" on `createdAt` answers "leads
     * created today" and silently drops every lead carried forward INTO today,
     * which is most of a rep's actual day. An export of that filter looked
     * complete and was missing exactly the leads that had moved.
     */
    const dateBounds = {
      ...(query.createdFrom ? { gte: new Date(query.createdFrom) } : {}),
      ...(query.createdTo ? { lte: new Date(`${query.createdTo.slice(0, 10)}T23:59:59.999Z`) } : {}),
    };
    const dateFilter: Prisma.LeadWhereInput = !(query.createdFrom || query.createdTo)
      ? {}
      : query.dateField === 'scheduled'
        ? { assignments: { some: { isActive: true, assignedAt: dateBounds } } }
        : { createdAt: dateBounds };

    // Closed Leads dates its rows by when they closed, which is a different
    // column and often a different month from when they were created.
    const closedAtFilter =
      query.closedFrom || query.closedTo
        ? {
            closedAt: {
              ...(query.closedFrom ? { gte: new Date(query.closedFrom) } : {}),
              ...(query.closedTo ? { lte: new Date(`${query.closedTo.slice(0, 10)}T23:59:59.999Z`) } : {}),
            },
          }
        : {};
    const closedByFilter = query.closedBy ? { closedBy: { name: query.closedBy } } : {};

    /**
     * Narrow the book to one employee's leads — admins only.
     *
     * The role check lives here rather than in a guard on the route because the
     * parameter is optional: everyone may call this endpoint, and only an admin
     * may use this one field. An employee is already pinned to their own leads
     * by `scope` above, but ignoring the field for them as well means a
     * hand-written request naming somebody else's id reads as "no filter"
     * rather than quietly relying on `scope` being spread in the right order.
     *
     * Team leaders are excluded deliberately — see the module docs.
     */
    const employeeFilter =
      user?.role === Role.admin && query.employeeId
        ? query.closed === true
          ? { closedById: query.employeeId }
          : { assignedToId: query.employeeId }
        : {};

    const where: Prisma.LeadWhereInput = {
      deletedAt: null,
      status: query.status,
      state: query.state,
      ...closedAtFilter,
      ...closedByFilter,
      ...closedFilter,
      ...scope,
      ...mineScope,
      ...employeeFilter,
      ...rangeFilter,
      ...searchFilter,
      ...cityFilter,
      ...zoneFilter,
      ...outcomeFilter,
      ...assignedFilter,
      ...dateFilter,
    };

    // ── Default ordering: the order the leads arrived in ──
    //
    // Lead #1 of the imported file is row 1 of the grid, #2 is row 2, and so on.
    // The default was `createdAt: 'desc'`, which showed an import upside down —
    // and, because a bulk import writes many rows inside one millisecond, showed
    // the rows within a millisecond in no fixed order at all.
    //
    // An explicit `sortBy` from the user still wins; that is the one thing that
    // may reorder the grid. The Closed Leads scope keeps `closedAt: 'desc'`: it
    // answers "what was closed recently", a question about closing order rather
    // than import order, and its own filters already narrow it to that.
    const primaryOrder: Prisma.LeadOrderByWithRelationInput = ranged
      ? { importSeq: 'asc' }
      : query.sortBy
        ? sortClause(query.sortBy, query.sortDir === 'asc' ? 'asc' : 'desc')
        : query.closed === true
          ? { closedAt: 'desc' }
          : { importSeq: 'asc' };

    /**
     * The sort, made total by `importSeq`.
     *
     * Every sortable column here has ties — leads created in the same
     * millisecond by an import, a whole state's worth of one city, any column
     * that is mostly null. SQL defines no order among tied rows, so `ORDER BY
     * <col> LIMIT n OFFSET m` may place a tied row in one chunk on one request
     * and a different chunk on the next. The list is read chunk by chunk as it
     * scrolls, so that would show one lead twice and silently skip another —
     * with nothing wrong in any single response, only at the seam between two.
     *
     * `importSeq` is unique, which makes the ordering total and every chunk
     * boundary deterministic. The tie-break used to be `id`, a random uuid,
     * which settled the order but settled it arbitrarily. Breaking ties on the
     * import sequence instead is what makes filtering and sorting PRESERVE the
     * file's order among equal rows: filter to one city and those leads stay in
     * the order they were imported in; sort by status and each status block
     * reads in import order. Clearing the filter restores the whole sequence
     * because nothing ever left it.
     */
    const orderBy: Prisma.LeadOrderByWithRelationInput[] = [primaryOrder, { importSeq: 'asc' }];

    // `idsOnly` exists for the callers that must reach across the whole book but
    // render none of it — the assign-by-range dialog wants 5,000 ids, not 5,000
    // full leads. `limit` stays for them; a paged caller gets `pageSize` instead.
    if (query.idsOnly) {
      const rows = await this.prisma.lead.findMany({ where, orderBy, take: query.limit ?? 5000, select: { id: true, leadId: true } });
      return { rows, total: rows.length, page: 1, pageSize: rows.length };
    }

    const pageSize = query.pageSize ?? query.limit ?? DEFAULT_PAGE_SIZE;
    const page = Math.max(1, query.page ?? 1);

    // Count and page in one round trip. The count is what lets the grid show a
    // real total and a real page count while holding only one page of rows.
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.lead.count({ where }),
      this.prisma.lead.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        // Explicit projection, not the whole row — see LIST_SELECT.
        select: LIST_SELECT,
      }),
    ]);

    // Flatten the scheduling facts onto the lead and drop the relations — the
    // client needs the date the lead is currently scheduled for, how it got
    // there, and how many times it has been carried into a new day. Not the
    // assignment rows themselves; the full trail is `assignmentHistory`.
    //
    // `createdAt` travels alongside untouched. The pair is the point: one date
    // says when the lead was created and never changes, the other says which day
    // it is being worked and moves.
    return {
      rows: rows.map(({ assignments, _count, ...lead }) => ({
        ...lead,
        assignedAt: assignments[0]?.assignedAt ?? null,
        assignmentType: assignments[0]?.type ?? null,
        carriedForwardCount: _count.assignments,
      })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * A lead's complete ownership history, newest first.
   *
   * Every handover, by whatever route — manual assignment, a batch, an import,
   * an edit to the lead — writes a row, and no row is ever rewritten. Deleting a
   * lead cascades them away with it, but nothing else removes one, so this is
   * the full audit trail of who assigned the lead, when, and to whom.
   *
   * The lead's own details are untouched by any of it: a handover changes the
   * owner and appends here, and nothing else about the lead moves.
   */
  async assignmentHistory(id: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, deletedAt: null },
      // The zone travels with the history so the client renders each stamp on
      // the LEAD's clock. Sent from here rather than passed in as a prop: this
      // view is opened from two places, and a zone supplied by the caller is a
      // zone that can be supplied wrongly.
      select: { id: true, leadId: true, businessName: true, timezone: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');

    const rows = await this.prisma.assignment.findMany({
      where: { leadId: id },
      orderBy: { assignedAt: 'desc' },
      select: {
        id: true,
        assignedAt: true,
        type: true,
        remarks: true,
        batchName: true,
        isActive: true,
        caller: { select: { id: true, name: true, email: true } },
        previousCaller: { select: { id: true, name: true, email: true } },
        assignedBy: { select: { id: true, name: true, email: true } },
      },
    });

    return rows.map((r) => ({
      id: r.id,
      // The lead is repeated on every row so a history entry can be read, or
      // exported, without needing the lead fetched alongside it — including the
      // zone its timestamps are to be read on.
      leadId: lead.leadId,
      leadName: lead.businessName,
      timezone: lead.timezone,
      previousEmployee: r.previousCaller?.name ?? null,
      newEmployee: r.caller.name,
      assignedBy: r.assignedBy.name,
      assignedAt: r.assignedAt,
      type: r.type,
      remarks: r.remarks ?? (r.batchName ? `Batch: ${r.batchName}` : null),
      /** The row naming the lead's owner right now. */
      current: r.isActive,
    }));
  }

  /**
   * Distinct timezones, states and cities for the filter dropdowns.
   *
   * The pages built these lists by mapping over every lead they held, which
   * meant they needed every lead. Three grouped reads over indexed columns
   * answer the same question without moving any rows.
   *
   * Cascading is honoured — states are those within the chosen timezone, cities
   * those within the chosen timezone and state — because that is how the
   * dropdowns behaved when they were derived in the browser.
   */
  async filterOptions(query: ListLeadsQueryDto, user?: { id: string; role: Role }) {
    const scope = user?.role === Role.employee ? { assignedToId: user.id } : {};
    const base: Prisma.LeadWhereInput = {
      deletedAt: null,
      ...scope,
      ...(query.closed === true ? { status: LeadStatus.closed } : query.closed === false ? { status: { not: LeadStatus.closed } } : {}),
    };
    const [zones, states, cities, closers] = await Promise.all([
      this.prisma.lead.groupBy({ by: ['timezone'], where: base, orderBy: { timezone: 'asc' } }),
      this.prisma.lead.groupBy({ by: ['state'], where: { ...base, ...timezoneWhere(query.timezone) }, orderBy: { state: 'asc' } }),
      this.prisma.lead.groupBy({
        by: ['city'],
        where: { ...base, ...timezoneWhere(query.timezone), ...(query.state ? { state: query.state } : {}) },
        orderBy: { city: 'asc' },
      }),
      // Who has closed anything — the Closed Leads module's employee filter.
      // Read from the users who actually appear as closers rather than from the
      // whole staff list, so the filter never offers a name with no leads
      // behind it. Only asked for when that module is the one asking.
      query.closed === true
        ? this.prisma.user.findMany({
            where: { closedLeads: { some: { deletedAt: null, status: LeadStatus.closed } } },
            select: { name: true },
            orderBy: { name: 'asc' },
          })
        : Promise.resolve([]),
    ]);
    return {
      // Leads with no zone are offered as their own filter value rather than
      // dropped. Without it there is no way to list the leads that still need a
      // zone picked — and those are exactly the ones no callback can be booked
      // against until someone finds them.
      timezones: zones.map((z) => tzLabel(z.timezone)),
      states: states.map((s) => s.state).filter(Boolean),
      cities: cities.map((c) => c.city).filter(Boolean),
      closers: closers.map((c) => c.name).filter(Boolean),
    };
  }

  /**
   * An outcome filter matches its slug and its display name.
   *
   * Looked up rather than assumed: the browser had the whole outcome list in
   * hand and could resolve the alias itself, and this filter has to keep
   * behaving the same way now that it runs in SQL.
   */
  private async callStatusAliases(slugOrName: string): Promise<string[]> {
    const found = await this.prisma.outcome.findFirst({
      where: { OR: [{ slug: slugOrName }, { name: { equals: slugOrName, mode: 'insensitive' } }] },
      select: { slug: true, name: true },
    });
    return found ? [...new Set([slugOrName, found.slug, found.name])] : [slugOrName];
  }

  async findOne(id: string, user?: { id: string; role: Role }) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, deletedAt: null },
      include: {
        assignedTo: { select: { id: true, name: true, email: true } },
        closedBy: { select: { id: true, name: true, email: true } },
        // The same scheduling pair the grid rows carry, so a lead opened on its
        // own page reports the day it is queued for and how many times it has
        // been moved — not only `createdAt`, which says when it arrived and is
        // the same on a lead carried for a month as on one created this morning.
        assignments: {
          where: { isActive: true },
          orderBy: { assignedAt: 'desc' },
          take: 1,
          select: { assignedAt: true, type: true },
        },
        _count: { select: { assignments: { where: { type: AssignmentType.carry_forward } } } },
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    // Employees may only open leads they are assigned or personally closed —
    // the latter keeps their Closed Leads rows openable after a reassignment.
    if (user?.role === Role.employee && lead.assignedToId !== user.id && lead.closedById !== user.id) {
      throw new NotFoundException('Lead not found');
    }
    const { assignments, _count, ...rest } = lead;
    return {
      ...rest,
      assignedAt: assignments[0]?.assignedAt ?? null,
      assignmentType: assignments[0]?.type ?? null,
      carriedForwardCount: _count.assignments,
    };
  }

  /**
   * Edit a lead (managers only — enforced at the controller). Applies only the
   * fields present in the DTO, diffs each against the current value, and writes
   * one activity per real change so the audit trail records field, old, and new.
   * `caller` (name/email) reassigns; `leadId` is immutable and ignored.
   */
  async update(id: string, dto: UpdateLeadDto, user: { id: string; role: Role }) {
    const existing = await this.prisma.lead.findFirst({
      where: { id, deletedAt: null },
      include: { assignedTo: { select: { id: true, name: true } } },
    });
    if (!existing) throw new NotFoundException('Lead not found');

    const data: Prisma.LeadUpdateInput = {};
    const logs: Array<{ action: string; field: string; oldValue: string | null; newValue: string | null }> = [];

    // Plain string fields — empty string clears to null.
    const strFields: Array<[keyof UpdateLeadDto & string, string]> = [
      ['businessName', 'Company name'], ['phone', 'Phone'], ['email', 'Email'],
      ['state', 'State'], ['city', 'City'], ['contactName', 'Contact name'],
      ['industry', 'Industry'], ['title', 'Title'],
      ['employeeCode', 'Employee code'], ['comments', 'Comments'], ['leadCategory', 'Lead category'],
      ['callStatus', 'Call status'], ['lostReason', 'Lost reason'],
      ['leadGenerationId', 'Lead generation ID'],
      ['leadSource', 'Lead source'],
      ['contactName2', 'Contact name 2'],
      ['altPhone', 'Alt phone'],
      ['website', 'Website'],
      ['socialMedia', 'Social media'],
      ['country', 'Country'],
      ['companySize', 'Company size'],
      ['foundedYear', 'Founded year'],
      ['address', 'Address'],
    ];
    for (const [key, fieldLabel] of strFields) {
      const raw = dto[key] as string | undefined;
      if (raw === undefined) continue;
      const next = raw.trim() === '' ? null : raw.trim();
      const prev = ((existing as Record<string, unknown>)[key] as string | null) ?? null;
      if (next !== prev) {
        (data as Record<string, unknown>)[key] = next;
        logs.push({ action: 'lead_updated', field: fieldLabel, oldValue: prev, newValue: next });
      }
    }

    if (dto.timezone !== undefined && dto.timezone !== existing.timezone) {
      data.timezone = dto.timezone;
      logs.push({ action: 'lead_updated', field: 'Timezone', oldValue: existing.timezone, newValue: dto.timezone });
    }
    if (dto.status !== undefined && dto.status !== existing.status) {
      data.status = dto.status;
      // Marking a lead closed moves it to the Closed Leads module, credited to
      // the user making the change; reopening it clears the closure.
      Object.assign(data, closureFields(dto.status, existing.status, user.id));
      logs.push({ action: 'status_changed', field: 'Status', oldValue: existing.status, newValue: dto.status });
    }
    if (dto.nextFollowUpDate !== undefined) {
      const next = dto.nextFollowUpDate ? new Date(dto.nextFollowUpDate) : null;
      const prevMs = existing.nextFollowUpDate?.getTime() ?? null;
      if ((next?.getTime() ?? null) !== prevMs) {
        data.nextFollowUpDate = next;
        logs.push({ action: 'lead_updated', field: 'Next follow-up', oldValue: existing.nextFollowUpDate?.toISOString() ?? null, newValue: next?.toISOString() ?? null });
      }
    }
    if (dto.firstContact !== undefined) {
      const next = dto.firstContact ? new Date(dto.firstContact) : null;
      const prevMs = existing.firstContact?.getTime() ?? null;
      if ((next?.getTime() ?? null) !== prevMs) {
        data.firstContact = next;
        logs.push({ action: 'lead_updated', field: 'First contact', oldValue: existing.firstContact?.toISOString() ?? null, newValue: next?.toISOString() ?? null });
      }
    }
    if (dto.lastContact !== undefined) {
      const next = dto.lastContact ? new Date(dto.lastContact) : null;
      const prevMs = existing.lastContact?.getTime() ?? null;
      if ((next?.getTime() ?? null) !== prevMs) {
        data.lastContact = next;
        logs.push({ action: 'lead_updated', field: 'Last contact', oldValue: existing.lastContact?.toISOString() ?? null, newValue: next?.toISOString() ?? null });
      }
    }
    if (dto.meetingDate !== undefined) {
      const next = dto.meetingDate ? new Date(dto.meetingDate) : null;
      const prevMs = existing.meetingDate?.getTime() ?? null;
      if ((next?.getTime() ?? null) !== prevMs) {
        data.meetingDate = next;
        logs.push({ action: 'lead_updated', field: 'Meeting date', oldValue: existing.meetingDate?.toISOString() ?? null, newValue: next?.toISOString() ?? null });
      }
    }
    if (dto.followupCount !== undefined) {
      const next = dto.followupCount ?? null;
      const prev = existing.followupCount ?? null;
      if (next !== prev) {
        data.followupCount = next;
        logs.push({ action: 'lead_updated', field: 'Follow-up count', oldValue: prev?.toString() ?? null, newValue: next?.toString() ?? null });
      }
    }

    // Reassignment: resolve the free-text caller (name/email) to a user.
    let reassignedTo: string | null = null;
    let sameDayConfirmed = false;
    if (dto.caller !== undefined) {
      const assignedToId = (await this.resolveCaller(dto.caller)) ?? null;
      if (assignedToId !== (existing.assignedToId ?? null)) {
        // One assignment a day by default, whichever route the change comes
        // through. Not a refusal any more: the caller may confirm it, and the
        // confirmation is what gets recorded against the handover.
        if (assignedToId && (await this.assignedToday(id))) {
          if (!dto.confirmSameDayReassign) {
            throw new BadRequestException(
              sameDayConfirmError([{ id, leadId: existing.leadId, assignedTo: existing.assignedTo?.name ?? null }]),
            );
          }
          sameDayConfirmed = true;
        }
        data.assignedTo = assignedToId ? { connect: { id: assignedToId } } : { disconnect: true };
        reassignedTo = assignedToId;
        logs.push({ action: 'lead_reassigned', field: 'Assigned to', oldValue: existing.assignedTo?.name ?? null, newValue: assignedToId ? dto.caller?.trim() ?? null : null });
      }
    }

    // A comment is APPENDED to the trail, so it is recorded even when it changes
    // no column — re-entering the same remark is a second real event, and the
    // early return below (which fires when nothing else changed) used to swallow
    // it along with the write. Done before that return for exactly that reason.
    await this.recordComment(id, dto.comments, user.id);

    if (Object.keys(data).length === 0) return existing; // nothing else changed

    const updated = await this.prisma.lead.update({
      where: { id },
      data,
      include: { assignedTo: { select: { id: true, name: true, email: true } } },
    });
    for (const l of logs) await this.log(id, user.id, l.action, l.oldValue, l.newValue, l.field);
    // Stamp the handover, carrying the owner it came FROM — read before the
    // update, since the lead now names the new one.
    if (reassignedTo) {
      await this.recordAssignment(id, reassignedTo, user.id, undefined, {
        previousCallerId: existing.assignedToId ?? null,
        remarks: sameDayConfirmed ? 'Same-day reassignment, confirmed by the assigner' : undefined,
      });
    }

    return updated;
  }

  /**
   * Append a comment to the lead's trail.
   *
   * `Lead.comments` only ever holds the LATEST remark (it's what the Lead
   * Management column reads), so each edit is also written to `notes` — the same
   * table call notes land in — keeping one chronological trail of both sources
   * instead of overwriting the previous remark with no record of it. A null
   * callId is what marks the entry as a manual update rather than a call.
   *
   * A remark identical to the one already on the lead is still recorded. It used
   * to be skipped as "no change", which is true of the column and false of the
   * trail: "left voicemail" on Monday and again on Thursday is two calls, and the
   * second one vanished. Only an empty comment is ignored — clearing the field is
   * not a remark.
   */
  private async recordComment(leadId: string, next: string | undefined, userId: string) {
    if (next === undefined) return;
    const text = next.trim();
    if (!text) return;
    await this.prisma.note.create({ data: { leadId, callId: null, noteText: text, createdById: userId } });
  }

  /**
   * Chronological comment history for a lead — manual edits and call notes in one
   * feed. Source is derived from `callId` rather than a stored flag: a note tied to
   * a call came from the Call Panel, one without came from a manual edit.
   */
  async commentHistory(id: string, limit = 100) {
    const notes = await this.prisma.note.findMany({
      where: { leadId: id },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, noteText: true, createdAt: true, callId: true, createdBy: { select: { name: true } } },
    });
    return notes.map((n) => ({
      id: n.id,
      text: n.noteText,
      at: n.createdAt,
      user: n.createdBy?.name ?? 'Unknown',
      source: n.callId ? ('Call Notes' as const) : ('Manual Update' as const),
    }));
  }

  /** Permanently delete a lead and every dependent record (hard delete).
   *  All child rows with a FK to the lead — assignments, calls (and their notes
   *  & coaching reports), notes, activities, messages, quo sync logs, zoom
   *  meetings (and their activities) — are removed by ON DELETE CASCADE.
   *  Denormalized audit rows that carry a lead_id without a FK
   *  (work_reassignments) are cleaned explicitly so no orphan reference remains.
   *  Employees may only delete their own assigned leads; managers delete any. */
  async remove(id: string, user?: { id: string; role: Role }) {
    const lead = await this.prisma.lead.findFirst({ where: { id, deletedAt: null }, select: { id: true, leadId: true, businessName: true, assignedToId: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (user?.role === Role.employee && lead.assignedToId !== user.id) {
      throw new NotFoundException('Lead not found');
    }

    await this.prisma.$transaction(async (tx) => {
      // No FK on this denormalized feed — remove its lead references by hand.
      await tx.workReassignment.deleteMany({ where: { leadId: id } });
      // Cascades to all dependent modules via ON DELETE CASCADE.
      await tx.lead.delete({ where: { id } });
      // Audit trail: recorded with a null leadId so it survives the cascade.
      if (user) {
        await tx.activity.create({
          data: { leadId: null, userId: user.id, action: 'lead_deleted', oldValue: null, newValue: null, remarks: `Permanently deleted lead ${lead.leadId} (${lead.businessName}) and all associated records` },
        });
      }
    });

    return { id, deleted: true };
  }

  /**
   * Delete many leads in ONE transaction.
   *
   * Deleting a selection used to mean one HTTP round-trip and one transaction per
   * lead, so removing a few hundred crawled and could fail half-way, leaving the
   * selection partly deleted. This removes the whole set atomically — it either
   * all goes or none of it does — which is also what makes an import rollback
   * safe to offer.
   *
   * Employees may only delete their own leads; ids they don't own are silently
   * excluded rather than failing the batch, matching how `remove` hides them.
   */
  /**
   * Take leads out of the book WITHOUT destroying them — the Duplicate Leads
   * purge, and the only delete in the CRM that can be taken back.
   *
   * `removeMany` below is a hard delete that cascades through calls, notes,
   * activities and assignments; nothing survives it, so the "undo" the purge
   * screen offers could not have been built on it. Here the row stays and only
   * `deletedAt` is stamped. Every read in the API already filters
   * `deletedAt: null`, so an archived lead disappears from the book, the
   * queues, the counts and the exports exactly as a deleted one did — the
   * difference is only that it can come back.
   *
   * Deliberately NOT what the single delete or the import rollback do. Rolling
   * back a bad import should genuinely remove what it wrote, and one lead
   * deleted by hand is a decision someone made about one record. This is the
   * bulk, semi-automatic path, where the mistake is plausible and expensive.
   */
  async archiveMany(ids: string[], user?: { id: string; role: Role }) {
    if (ids.length === 0) return { archived: 0, ids: [] as string[] };
    const leads = await this.prisma.lead.findMany({
      where: {
        id: { in: ids },
        deletedAt: null,
        ...(user?.role === Role.employee ? { assignedToId: user.id } : {}),
      },
      select: { id: true, leadId: true },
    });
    if (leads.length === 0) return { archived: 0, ids: [] as string[] };
    const found = leads.map((l) => l.id);

    await this.prisma.$transaction(async (tx) => {
      await tx.lead.updateMany({ where: { id: { in: found } }, data: { deletedAt: new Date() } });
      if (user) {
        await tx.activity.create({
          data: {
            // The leads survive, so this could reference one of them — but it
            // describes a batch, and filing it under an arbitrary member is how
            // an audit trail starts lying about scope.
            leadId: null,
            userId: user.id,
            action: 'lead_archived',
            oldValue: null,
            newValue: null,
            remarks: `Removed ${found.length} duplicate lead(s), reversible: ${leads
              .slice(0, 20)
              .map((l) => l.leadId)
              .join(', ')}${found.length > 20 ? ` +${found.length - 20} more` : ''}`,
          },
        });
      }
    });

    // The ids go back so the caller can offer an undo for exactly this batch,
    // rather than for "whatever was archived recently".
    return { archived: found.length, ids: found };
  }

  /**
   * Put archived leads back. Only rows that are actually archived are touched,
   * so replaying an undo cannot resurrect anything the user deleted since.
   */
  async restoreMany(ids: string[], user?: { id: string; role: Role }) {
    if (ids.length === 0) return { restored: 0 };
    const leads = await this.prisma.lead.findMany({
      where: {
        id: { in: ids },
        deletedAt: { not: null },
        ...(user?.role === Role.employee ? { assignedToId: user.id } : {}),
      },
      select: { id: true, leadId: true },
    });
    if (leads.length === 0) return { restored: 0 };
    const found = leads.map((l) => l.id);

    await this.prisma.$transaction(async (tx) => {
      await tx.lead.updateMany({ where: { id: { in: found } }, data: { deletedAt: null } });
      if (user) {
        await tx.activity.create({
          data: {
            leadId: null,
            userId: user.id,
            action: 'lead_restored',
            oldValue: null,
            newValue: null,
            remarks: `Restored ${found.length} removed lead(s): ${leads
              .slice(0, 20)
              .map((l) => l.leadId)
              .join(', ')}${found.length > 20 ? ` +${found.length - 20} more` : ''}`,
          },
        });
      }
    });

    return { restored: found.length };
  }

  async removeMany(ids: string[], user?: { id: string; role: Role }) {
    if (ids.length === 0) return { deleted: 0 };
    const leads = await this.prisma.lead.findMany({
      where: {
        id: { in: ids },
        deletedAt: null,
        ...(user?.role === Role.employee ? { assignedToId: user.id } : {}),
      },
      select: { id: true, leadId: true, businessName: true },
    });
    if (leads.length === 0) return { deleted: 0 };
    const found = leads.map((l) => l.id);

    await this.prisma.$transaction(async (tx) => {
      // No FK on this denormalized feed — clear its lead references by hand.
      await tx.workReassignment.deleteMany({ where: { leadId: { in: found } } });
      // Cascades to every dependent module via ON DELETE CASCADE.
      await tx.lead.deleteMany({ where: { id: { in: found } } });
      // Audit trail: leadId is null so the row survives the cascade it describes.
      if (user) {
        await tx.activity.create({
          data: {
            leadId: null,
            userId: user.id,
            action: 'lead_deleted',
            oldValue: null,
            newValue: null,
            remarks: `Permanently deleted ${found.length} lead(s) and all associated records: ${leads
              .slice(0, 20)
              .map((l) => l.leadId)
              .join(', ')}${found.length > 20 ? ` +${found.length - 20} more` : ''}`,
          },
        });
      }
    });

    return { deleted: found.length };
  }
}
