import { Injectable, NotFoundException } from '@nestjs/common';
import { Timezone, LeadStatus, Role, Prisma } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateLeadDto, ImportLeadsDto, ListLeadsQueryDto, UpdateLeadDto } from './dto/lead.dto';
import { closureCreateFields, closureFields } from './lead-closure';

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
  private async resolveCaller(caller?: string): Promise<string | undefined> {
    const q = caller?.trim();
    if (!q) return undefined;
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: { equals: q, mode: 'insensitive' } }, { name: { equals: q, mode: 'insensitive' } }] },
      select: { id: true },
    });
    return user?.id;
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
      if (assignedToId) await this.log(lead.id, userId, 'lead_assigned', null, assignedToId, 'Initial assignment');
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
  async bulkImport(dto: ImportLeadsDto, userId?: string) {
    const errors: Array<{ row: number; reason: string }> = [];
    const seenInFile = new Set<string>();
    const callerCache = new Map<string, string | undefined>();
    let imported = 0;
    let updated = 0;

    const resolveAssigned = async (caller?: string) => {
      const key = caller?.trim().toLowerCase();
      if (!key) return undefined;
      if (!callerCache.has(key)) callerCache.set(key, await this.resolveCaller(caller));
      return callerCache.get(key);
    };

    for (let i = 0; i < dto.rows.length; i++) {
      const row = dto.rows[i];
      const n = i + 1;
      const phoneKey = (row.phone ?? '').replace(/\D/g, '');
      // No required fields — only skip duplicate phones within the same file.
      if (phoneKey) {
        if (seenInFile.has(phoneKey)) {
          errors.push({ row: n, reason: 'Duplicate phone within file' });
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

      const assignedToId = await resolveAssigned(row.caller);
      const assignRel = assignedToId ? { assignedTo: { connect: { id: assignedToId } } } : {};

      // Match an existing lead by leadId or phone (last 10 digits), if any.
      const last10 = phoneKey.slice(-10);
      const existing = last10 || row.leadId
        ? await this.prisma.lead.findFirst({
            where: {
              deletedAt: null,
              OR: [...(row.leadId ? [{ leadId: row.leadId }] : []), ...(last10 ? [{ phone: { contains: last10 } }] : [])],
            },
            select: { id: true, status: true },
          })
        : null;

      if (existing) {
        // An imported row that closes (or reopens) a lead is credited to the
        // row's CALLER — the rep the sheet names — never to whoever ran the
        // import.
        const closure = closureFields(data.status as LeadStatus | undefined, existing.status, assignedToId ?? null);
        const updatedLead = await this.prisma.lead.update({ where: { id: existing.id }, data: { ...data, ...assignRel, ...closure } });
        if (userId) await this.log(updatedLead.id, userId, 'lead_updated', null, null, 'Imported row updated lead');
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

    return { imported, updated, skipped: 0, errors, totalRows: dto.rows.length };
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
    return this.prisma.lead.findMany({
      where: { deletedAt: null, status: query.status, state: query.state, ...closedFilter, ...scope },
      orderBy: query.closed === true ? { closedAt: 'desc' } : { createdAt: 'desc' },
      take: 100,
      include: {
        assignedTo: { select: { id: true, name: true, email: true } },
        closedBy: { select: { id: true, name: true, email: true } },
      },
    });
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
    if (dto.caller !== undefined) {
      const assignedToId = (await this.resolveCaller(dto.caller)) ?? null;
      if (assignedToId !== (existing.assignedToId ?? null)) {
        data.assignedTo = assignedToId ? { connect: { id: assignedToId } } : { disconnect: true };
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
    return updated;
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
}
