import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AssignmentType, Timezone, LeadStatus, Role, Prisma } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateLeadDto, ImportLeadsDto, ListLeadsQueryDto, UpdateLeadDto } from './dto/lead.dto';
import { closureCreateFields, closureFields } from './lead-closure';
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
  // Newest active handover, used to expose `assignedAt` on the row.
  assignments: { where: { isActive: true }, orderBy: { assignedAt: 'desc' }, take: 1, select: { assignedAt: true } },
} satisfies Prisma.LeadSelect;

/**
 * Columns the grid may sort by, and what each one means in SQL.
 *
 * A whitelist because `sortBy` arrives from the query string and is interpolated
 * into an orderBy — an open one would let a caller order by any column, or by a
 * relation, and turn a page into a full scan and sort.
 *
 * `leadId` maps to `createdAt`. Sorting by the id STRING is wrong — "L-2026-10"
 * sorts before "L-2026-2" — and sorting by the parsed sequence number needs an
 * expression no index covers, which is a scan and a sort of the whole book on
 * the module's DEFAULT ordering. Ids are minted in creation order, so createdAt
 * is the same order and is indexed. (findAll already relies on this equivalence
 * for ranged reads, and has since before this change.)
 */
const SORTABLE: Record<string, (dir: Prisma.SortOrder) => Prisma.LeadOrderByWithRelationInput> = {
  leadId: (dir) => ({ createdAt: dir }),
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
  private async assignedToday(leadId: string): Promise<boolean> {
    const since = LeadsService.startOfToday();
    const n = await this.prisma.assignment.count({ where: { leadId, assignedAt: { gte: since } } });
    return n > 0;
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
   * Generation itself lives in LeadIdService, shared with every other module
   * that can bring a lead into the CRM, so a lead created here and one created
   * from an unrecognised inbound caller are numbered by the same rule.
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
  /**
   * Flag which import rows duplicate an existing lead or an earlier row in the
   * same file, matched on Company Name, Phone (last 10 digits) or Email — any one
   * hit counts. Used both by the pre-import check (so the user is warned before
   * anything is written) and by the import itself when "skip duplicates" is chosen,
   * so the two can never disagree about what a duplicate is.
   */
  async analyzeImport(rows: CreateLeadDto[], checkFields?: string[]) {
    const checkAll = !checkFields || checkFields.length === 0;
    const checkName = checkAll || checkFields.includes('businessName') || checkFields.includes('companyName');
    const checkPhone = checkAll || checkFields.includes('phone');
    const checkEmail = checkAll || checkFields.includes('email');

    const nameKey = (v?: string | null) => (v ?? '').trim().toLowerCase();
    const phoneKey = (v?: string | null) => (v ?? '').replace(/\D/g, '').slice(-10);
    const emailKey = (v?: string | null) => (v ?? '').trim().toLowerCase();

    // Existing leads, loaded once and indexed by each match key → the lead itself,
    // so a flagged row can carry the record it clashed with (for the preview grid),
    // not just a boolean. Bounded so a huge book can't turn a check into an
    // unbounded scan; beyond the cap, matches past it just aren't flagged.
    const existing = await this.prisma.lead.findMany({
      where: { deletedAt: null },
      select: { leadId: true, businessName: true, phone: true, email: true, createdAt: true, assignedTo: { select: { name: true } } },
      take: 50_000,
    });
    type Match = { leadId: string; businessName: string; phone: string; email: string | null; assignedTo: string | null; createdAt: Date };
    const toMatch = (l: (typeof existing)[number]): Match => ({
      leadId: l.leadId,
      businessName: l.businessName,
      phone: l.phone,
      email: l.email,
      assignedTo: l.assignedTo?.name ?? null,
      createdAt: l.createdAt,
    });
    const exName = new Map<string, Match>();
    const exPhone = new Map<string, Match>();
    const exEmail = new Map<string, Match>();
    for (const l of existing) {
      const m = toMatch(l);
      const nm = nameKey(l.businessName), ph = phoneKey(l.phone), em = emailKey(l.email);
      if (nm && !exName.has(nm)) exName.set(nm, m);
      if (ph && !exPhone.has(ph)) exPhone.set(ph, m);
      if (em && !exEmail.has(em)) exEmail.set(em, m);
    }

    // Within-file repeats: a key already seen in an EARLIER row of the same upload.
    const seenName = new Set<string>();
    const seenPhone = new Set<string>();
    const seenEmail = new Set<string>();
    const perRow = rows.map((r, index) => {
      const nm = nameKey(r.businessName);
      const ph = phoneKey(r.phone);
      const em = emailKey(r.email);
      const on: string[] = [];
      let existingMatch: Match | null = null;
      if (checkName && nm && (exName.has(nm) || seenName.has(nm))) { on.push('Company Name'); existingMatch ??= exName.get(nm) ?? null; }
      if (checkPhone && ph && (exPhone.has(ph) || seenPhone.has(ph))) { on.push('Phone'); existingMatch ??= exPhone.get(ph) ?? null; }
      if (checkEmail && em && (exEmail.has(em) || seenEmail.has(em))) { on.push('Email'); existingMatch ??= exEmail.get(em) ?? null; }
      if (nm) seenName.add(nm);
      if (ph) seenPhone.add(ph);
      if (em) seenEmail.add(em);
      return {
        index,
        duplicate: on.length > 0,
        matchedOn: on,
        // The import row's own key fields, for the left side of the preview grid.
        row: { businessName: r.businessName ?? '', phone: r.phone ?? '', email: r.email ?? '' },
        // The CRM lead it clashed with, when the clash is against an existing lead
        // (null when it only repeats an earlier row in the same file).
        existing: existingMatch,
      };
    });

    const duplicateRecords = perRow.filter((r) => r.duplicate).length;
    return {
      total: rows.length,
      duplicateRecords,
      newRecords: rows.length - duplicateRecords,
      rows: perRow,
    };
  }

  async bulkImport(dto: ImportLeadsDto, userId?: string) {
    const errors: Array<{ row: number; reason: string }> = [];
    const seenInFile = new Set<string>();
    const callerCache = new Map<string, string | undefined>();
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

    // Duplicate flags for the whole file based on checkFields
    const analysis = await this.analyzeImport(dto.rows, dto.checkFields);
    const dupByIndex = analysis.rows;
    const skipRowSet = new Set(dto.skipRowIndexes ?? []);
    let duplicateRecords = 0;
    let skipped = 0;

    for (let i = 0; i < dto.rows.length; i++) {
      const row = dto.rows[i];
      const n = i + 1;
      const phoneKey = (row.phone ?? '').replace(/\D/g, '');

      const isDuplicate = dupByIndex[i]?.duplicate ?? false;
      if (isDuplicate) {
        duplicateRecords++;
        const shouldSkip = dto.skipDuplicates || skipRowSet.has(i);
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
      // A same-file phone repeat is already a flagged duplicate above; this second
      // guard only matters when the user imported anyway, where writing the same
      // phone twice in one run would otherwise collide.
      if (phoneKey && !isDuplicate) {
        if (seenInFile.has(phoneKey)) {
          errors.push({ row: n, reason: 'Duplicate phone within file' });
          skipped++;
          continue;
        }
        seenInFile.add(phoneKey);
      }

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
      const last10 = phoneKey.slice(-10);
      const existing = last10 || row.leadId
        ? await this.prisma.lead.findFirst({
            where: {
              deletedAt: null,
              OR: [...(row.leadId ? [{ leadId: row.leadId }] : []), ...(last10 ? [{ phone: { contains: last10 } }] : [])],
            },
            select: { id: true, status: true, assignedToId: true, assignedTo: { select: { name: true } } },
          })
        : null;

      if (existing) {
        // A lead has exactly one owner, so an import must not take one off the
        // employee already holding it — the sheet updates the lead's fields, but
        // ownership stays put and the clash is reported.
        const ownedByOther = !!existing.assignedToId && !!assignedToId && existing.assignedToId !== assignedToId;
        if (ownedByOther) {
          errors.push({
            row: n,
            reason: `Already assigned to ${existing.assignedTo?.name ?? 'another employee'} — ownership left unchanged.`,
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
        const lockedToday = !ownedByOther && !!assignedToId && existing.assignedToId !== assignedToId && (await this.assignedToday(existing.id));
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
        const closure = closureFields(data.status as LeadStatus | undefined, existing.status, assignedToId ?? null);
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
              timezone: Timezone.EST,
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
        // A brand-new lead has no prior owner, so the sheet's employee always wins.
        if (assignedToId) {
          assignOk++;
          if (userId) await this.recordAssignment(created.id, assignedToId, userId, 'Excel import', { previousCallerId: null });
        }
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

  /** Pre-import scan: how many rows are new vs duplicate, and which rows. */
  async checkImport(rows: CreateLeadDto[], checkFields?: string[]) {
    const a = await this.analyzeImport(rows, checkFields);
    return {
      total: a.total,
      newRecords: a.newRecords,
      duplicateRecords: a.duplicateRecords,
      // Only the duplicate rows, so the client can highlight them without shipping
      // a flag for every single row.
      duplicateRows: a.rows.filter((r) => r.duplicate),
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
    const zoneFilter = query.timezone ? { timezone: query.timezone } : {};
    // A lead dispositioned through the CRM stores the outcome's SLUG
    // (`call_back`); leads imported before the outcome list existed carry the
    // display NAME ("Call Back"). Both match, exactly as the browser filter did
    // — dropping the alias would silently stop matching every imported lead.
    const outcomeFilter = query.callStatus
      ? { callStatus: { in: await this.callStatusAliases(query.callStatus), mode: 'insensitive' as const } }
      : {};
    const assignedFilter =
      query.assigned === 'assigned' ? { assignedToId: { not: null } } : query.assigned === 'unassigned' ? { assignedToId: null } : {};
    const createdFilter =
      query.createdFrom || query.createdTo
        ? {
            createdAt: {
              ...(query.createdFrom ? { gte: new Date(query.createdFrom) } : {}),
              ...(query.createdTo ? { lte: new Date(`${query.createdTo.slice(0, 10)}T23:59:59.999Z`) } : {}),
            },
          }
        : {};

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

    const where: Prisma.LeadWhereInput = {
      deletedAt: null,
      status: query.status,
      state: query.state,
      ...closedAtFilter,
      ...closedByFilter,
      ...closedFilter,
      ...scope,
      ...mineScope,
      ...rangeFilter,
      ...searchFilter,
      ...cityFilter,
      ...zoneFilter,
      ...outcomeFilter,
      ...assignedFilter,
      ...createdFilter,
    };

    // A ranged read is listed oldest-first: lead ids are handed out in creation
    // order, so that IS ascending sequence order — and unlike `leadId: 'asc'` it
    // doesn't put L-2026-10 ahead of L-2026-2.
    const primaryOrder: Prisma.LeadOrderByWithRelationInput = ranged
      ? { createdAt: 'asc' }
      : query.sortBy
        ? sortClause(query.sortBy, query.sortDir === 'asc' ? 'asc' : 'desc')
        : query.closed === true
          ? { closedAt: 'desc' }
          : { createdAt: 'desc' };

    /**
     * The sort, made total by `id`.
     *
     * Every sortable column here has ties — leads created in the same
     * millisecond by an import, a whole state's worth of one city, any column
     * that is mostly null. SQL defines no order among tied rows, so `ORDER BY
     * <col> LIMIT n OFFSET m` may place a tied row in one chunk on one request
     * and a different chunk on the next. The list is read chunk by chunk as it
     * scrolls, so that would show one lead twice and silently skip another —
     * with nothing wrong in any single response, only at the seam between two.
     *
     * `id` is unique, which makes the ordering total and every chunk boundary
     * deterministic. It never changes the visible order; it only decides what
     * was previously undefined.
     *
     * This is a guarantee, not a repair: walking 180 leads that share a single
     * createdAt returned each exactly once without it too, because nothing
     * forced Postgres to change plan between chunks. Relying on that is relying
     * on the planner not to do something it is entitled to do.
     */
    const orderBy: Prisma.LeadOrderByWithRelationInput[] = [primaryOrder, { id: 'asc' }];

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

    // Flatten the handover date onto the lead and drop the relation — the client
    // only needs "when did this change hands", which is what the same-day lock
    // keys off, not the assignment rows themselves.
    return {
      rows: rows.map(({ assignments, ...lead }) => ({ ...lead, assignedAt: assignments[0]?.assignedAt ?? null })),
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
      select: { id: true, leadId: true, businessName: true },
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
      // exported, without needing the lead fetched alongside it.
      leadId: lead.leadId,
      leadName: lead.businessName,
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
      this.prisma.lead.groupBy({ by: ['state'], where: { ...base, ...(query.timezone ? { timezone: query.timezone } : {}) }, orderBy: { state: 'asc' } }),
      this.prisma.lead.groupBy({
        by: ['city'],
        where: { ...base, ...(query.timezone ? { timezone: query.timezone } : {}), ...(query.state ? { state: query.state } : {}) },
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
      timezones: zones.map((z) => z.timezone as string).filter(Boolean),
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
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    // Employees may only open leads they are assigned or personally closed —
    // the latter keeps their Closed Leads rows openable after a reassignment.
    if (user?.role === Role.employee && lead.assignedToId !== user.id && lead.closedById !== user.id) {
      throw new NotFoundException('Lead not found');
    }
    return lead;
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

    if (Object.keys(data).length === 0) return existing; // nothing changed

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

    // Comment history. `Lead.comments` only ever holds the LATEST remark (it's what
    // the Lead Management column reads), so each edit is also appended to `notes` —
    // the same table call notes land in. That keeps one chronological trail of both
    // sources instead of overwriting the previous remark with no record of it. A
    // null callId is what marks this entry as a manual update rather than a call.
    if (dto.comments !== undefined) {
      const text = (dto.comments ?? '').trim();
      if (text && text !== (existing.comments ?? '').trim()) {
        await this.prisma.note.create({ data: { leadId: id, callId: null, noteText: text, createdById: user.id } });
      }
    }
    return updated;
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
