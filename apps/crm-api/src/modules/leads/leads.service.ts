import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Timezone, LeadStatus, Role, Prisma } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateLeadDto, ImportLeadsDto, ListLeadsQueryDto, UpdateLeadDto } from './dto/lead.dto';
import { closureCreateFields, closureFields } from './lead-closure';

/**
 * Shown wherever a same-day reassignment is refused. A lead keeps one owner for
 * the whole day it was handed over, so the work isn't pulled out from under
 * whoever started on it; the next calendar day it's free again.
 */
export const SAME_DAY_LOCK_MESSAGE =
  'This lead has already been assigned today. Reassignment is allowed only from the next day.';

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
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
  private async recordAssignment(leadId: string, callerId: string, assignedById: string, batchName?: string) {
    await this.prisma.assignment.updateMany({ where: { leadId, isActive: true }, data: { isActive: false } });
    await this.prisma.assignment.create({ data: { leadId, callerId, assignedById, batchName } });
  }

  /** Was this lead handed to someone today? If so it's locked until tomorrow. */
  private async assignedToday(leadId: string): Promise<boolean> {
    const since = LeadsService.startOfToday();
    const n = await this.prisma.assignment.count({
      where: { leadId, isActive: true, assignedAt: { gte: since } },
    });
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

  /** Generate next lead id in the format L-YYYY-N (e.g. L-2026-1, L-2026-2). */
  private async nextLeadId(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `L-${year}-`;
    // Find the highest existing sequence number for the current year.
    // NB: the start position must be cast to ::int. A bound parameter arrives as
    // text, and `SUBSTRING(x FROM <text>)` is read as the POSIX-regex form
    // (pattern) rather than positional extraction — which silently returns NULL,
    // making every generated id collide on "L-YYYY-1". `::int` forces the
    // positional form.
    const rows = await this.prisma.$queryRaw<Array<{ max_seq: number | null }>>(Prisma.sql`
      SELECT MAX(
        CAST(SUBSTRING(lead_id FROM ${prefix.length + 1}::int) AS INTEGER)
      ) AS max_seq
      FROM leads
      WHERE lead_id LIKE ${prefix + '%'}
        AND lead_id ~ ${'^L-' + year + '-[0-9]+$'}
    `);
    const next = (rows[0]?.max_seq ?? 0) + 1;
    return `${prefix}${next}`;
  }

  /**
   * Create a lead, regenerating the id and retrying when an auto-generated
   * `leadId` collides. `nextLeadId()` computes the sequence in application code,
   * so two concurrent creates (or overlapping bulk imports) can land on the same
   * number; the `@@unique([leadId])` constraint rejects the loser with P2002 and
   * we simply recompute and insert again. A caller-supplied `explicitLeadId` is
   * never retried — its conflict is a real error and is surfaced to the caller.
   */
  private async createLead(
    buildData: (leadId: string) => Prisma.LeadCreateInput,
    explicitLeadId?: string,
  ) {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; ; attempt++) {
      const leadId = explicitLeadId ?? (await this.nextLeadId());
      try {
        return await this.prisma.lead.create({ data: buildData(leadId) });
      } catch (e) {
        const collided =
          e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
        // Only retry auto-generated collisions, and only up to the cap.
        if (explicitLeadId || !collided || attempt >= MAX_ATTEMPTS) throw e;
      }
    }
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
        await this.recordAssignment(lead.id, assignedToId, userId);
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
  async analyzeImport(rows: CreateLeadDto[]) {
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
      if (nm && (exName.has(nm) || seenName.has(nm))) { on.push('Company Name'); existingMatch ??= exName.get(nm) ?? null; }
      if (ph && (exPhone.has(ph) || seenPhone.has(ph))) { on.push('Phone'); existingMatch ??= exPhone.get(ph) ?? null; }
      if (em && (exEmail.has(em) || seenEmail.has(em))) { on.push('Email'); existingMatch ??= exEmail.get(em) ?? null; }
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

    // Duplicate flags (Company Name / Phone / Email) for the whole file, computed
    // once up front. `skipDuplicates` uses them to leave duplicates out; when the
    // user chose "import anyway" they're counted but still imported.
    const analysis = await this.analyzeImport(dto.rows);
    const dupByIndex = analysis.rows;
    let duplicateRecords = 0;
    let skipped = 0;

    for (let i = 0; i < dto.rows.length; i++) {
      const row = dto.rows[i];
      const n = i + 1;
      const phoneKey = (row.phone ?? '').replace(/\D/g, '');

      const isDuplicate = dupByIndex[i]?.duplicate ?? false;
      if (isDuplicate) {
        duplicateRecords++;
        if (dto.skipDuplicates) {
          skipped++;
          errors.push({ row: n, reason: `Skipped duplicate (matched on ${dupByIndex[i].matchedOn.join(', ')})` });
          continue;
        }
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
        // Same-day lock: a lead handed over earlier today stays with its owner even
        // if the sheet names someone else, so a re-import can't shuffle ownership
        // mid-day.
        const lockedToday = !ownedByOther && !!assignedToId && existing.assignedToId !== assignedToId && (await this.assignedToday(existing.id));
        if (lockedToday) {
          errors.push({ row: n, reason: SAME_DAY_LOCK_MESSAGE });
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
        // Record the handover so the lock applies to it from here on.
        if (changedOwner && userId) await this.recordAssignment(existing.id, assignedToId!, userId, 'Excel import');
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
          if (userId) await this.recordAssignment(created.id, assignedToId, userId, 'Excel import');
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
  async checkImport(rows: CreateLeadDto[]) {
    const a = await this.analyzeImport(rows);
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
    // Admins & team leaders see every lead in either module.
    const scope =
      user?.role === Role.employee
        ? query.closed === true
          ? { closedById: user.id }
          : { assignedToId: user.id }
        : {};
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
    const rows = await this.prisma.lead.findMany({
      where: { deletedAt: null, status: query.status, state: query.state, ...closedFilter, ...scope, ...rangeFilter },
      // A ranged read is listed oldest-first: lead ids are handed out in creation
      // order, so that IS ascending sequence order — and unlike `leadId: 'asc'` it
      // doesn't put L-2026-10 ahead of L-2026-2.
      orderBy: ranged ? { createdAt: 'asc' } : query.closed === true ? { closedAt: 'desc' } : { createdAt: 'desc' },
      // Was a hardcoded 100, which quietly truncated the list: importing 300 leads
      // showed only 100, so "select all" could never reach the rest to bulk-assign
      // them. Caller-controlled, with a generous default and a hard ceiling in the
      // DTO so this can't turn into an unbounded scan.
      take: query.limit ?? 1000,
      include: {
        assignedTo: { select: { id: true, name: true, email: true } },
        closedBy: { select: { id: true, name: true, email: true } },
        // Newest active handover, used to expose `assignedAt` below.
        assignments: { where: { isActive: true }, orderBy: { assignedAt: 'desc' }, take: 1, select: { assignedAt: true } },
      },
    });

    // Flatten the handover date onto the lead and drop the relation — the client
    // only needs "when did this change hands", which is what the same-day lock
    // keys off, not the assignment rows themselves.
    return rows.map(({ assignments, ...lead }) => ({
      ...lead,
      assignedAt: assignments[0]?.assignedAt ?? null,
    }));
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
    if (dto.caller !== undefined) {
      const assignedToId = (await this.resolveCaller(dto.caller)) ?? null;
      if (assignedToId !== (existing.assignedToId ?? null)) {
        // A lead assigned earlier today is held by its owner for the rest of the
        // day, whichever route the reassignment comes through.
        if (assignedToId && (await this.assignedToday(id))) {
          throw new BadRequestException(SAME_DAY_LOCK_MESSAGE);
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
    // Stamp the handover so the same-day lock can see it tomorrow morning.
    if (reassignedTo) await this.recordAssignment(id, reassignedTo, user.id);

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
