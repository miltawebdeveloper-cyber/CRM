import { api } from './api';

export type QuoStatus = 'not_synced' | 'pending' | 'synced' | 'failed';

export interface Lead {
  id: string;
  /**
   * Position in the order this lead entered the CRM — its row in the imported
   * spreadsheet. The grid's default order and the tie-breaker under every other
   * sort, so filtering never disturbs the file's sequence.
   */
  importSeq: number;
  leadId: string;
  businessName: string;
  phone: string;
  email: string | null;
  state: string;
  city: string;
  /** Null when nobody has set one — a callback can't be scheduled until it is. */
  timezone: string | null;
  status: string;
  // ── Lead sheet fields ──
  contactName: string | null;
  industry: string | null;
  title: string | null;
  employeeCode: string | null;
  comments: string | null;   // latest remark; full trail via leadsApi.commentHistory
  /**
   * The day this lead is currently scheduled to be worked — its active
   * assignment's stamp. Moves: a reassignment sets it, and the overnight
   * carry-forward re-stamps an unfinished lead into its next local day. Also
   * what the same-day reassignment lock reads (same day = locked until tomorrow).
   *
   * NOT `createdAt`. That one records when the lead was first created and is
   * rewritten by nothing, so the pair tells you both when a lead entered the CRM
   * and which day's queue it is sitting on now.
   */
  assignedAt?: string | null;
  /** How the lead came to be scheduled for `assignedAt` — a fresh assignment, a
   *  handover, or an automatic move into the next day. */
  assignmentType?: 'new_assignment' | 'reassignment' | 'carry_forward' | null;
  /** How many times the lead has been moved to a next day without being finished. */
  carriedForwardCount?: number;

  leadCategory: string | null;
  nextFollowUpDate: string | null;
  callStatus: string | null;
  firstContact: string | null;
  lastContact: string | null;
  followupCount: number | null;
  meetingDate: string | null;
  lostReason: string | null;
  callbackAt: string | null;
  callbackCompletedAt: string | null;
  leadGenerationId: string | null;
  leadSource: string | null;
  contactName2: string | null;
  altPhone: string | null;
  website: string | null;
  socialMedia: string | null;
  country: string | null;
  companySize: string | null;
  foundedYear: string | null;
  address: string | null;
  // ── Derived call state (caller queue ordering) ──
  lastCallAt?: string | null;
  lastCallEndedAt?: string | null;
  lastOutcome?: string | null;
  /**
   * When the logged-in rep last saved this lead today, from the server. Nothing
   * stamps `lastCallEndedAt` when calling is off, so this is what tells the queue
   * a lead is already worked — and unlike the panel's in-memory set it survives a
   * page refresh, a queue refresh and a re-login.
   */
  lastWorkedAt?: string | null;
  /**
   * Where this lead stands in the call lifecycle — New Call → In Progress →
   * Completed — as decided by the API's calling-queue endpoint.
   *
   * Only `/calls/caller/leads` sets it; it is absent everywhere else, which is
   * why it is optional. Read it rather than working the answer out again from
   * `lastCallEndedAt`, `lastWorkedAt` and `status`: the panel used to do exactly
   * that in two places, the two definitions disagreed about closed leads, and a
   * finished lead could wear a tick and a "New Call" badge at once.
   *
   * `completed` is not permanent. A lead worked at 10am with a callback booked
   * for 2pm reports `completed` until 2pm and `new` from then on, which is what
   * takes it out of the queue in between and puts it back when the customer is
   * expecting the call.
   */
  queueStatus?: 'new' | 'in_progress' | 'completed';
  nextZoomMeeting?: {
    id: string;
    title: string | null;
    scheduledAt: string;
    durationMins: number;
    status: string;
    joinUrl: string | null;
    meetingId: string | null;
  } | null;
  assignedTo: { id: string; name: string; email: string } | null;
  // ── Closure (Closed Leads module) ── set while status is 'closed'.
  closedAt: string | null;
  closedBy: { id: string; name: string; email: string } | null;
  quoStatus: QuoStatus;
  quoExternalId: string | null;
  quoResponse: unknown;
  quoError: string | null;
  quoSyncedAt: string | null;
  /**
   * When the lead was ORIGINALLY created — the timestamp Lead Management shows
   * as Created Date & Time.
   *
   * Written once and rewritten by nothing. Reassigning the lead, carrying it
   * into the next day, editing any field: none of them touch it, so a lead
   * carried across a fortnight still reports the hour it first arrived. Use
   * `assignedAt` for the day it is currently being worked.
   */
  createdAt: string;
}

/**
 * Warning shown wherever a same-day reassignment is refused. Mirrors the API's
 * message so the client blocks with the same wording the server would.
 */
export const SAME_DAY_LOCK_MESSAGE =
  'This lead has already been assigned today to another employee. Do you want to reassign it?';

/**
 * True when the lead changed hands earlier today, which locks it to its current
 * owner until tomorrow. `assignedAt` is the newest active handover.
 */
export function isAssignedToday(lead: { assignedAt?: string | null }): boolean {
  if (!lead.assignedAt) return false;
  const at = new Date(lead.assignedAt);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return at >= start;
}

/**
 * Why this lead is sitting on the date it is scheduled for, in words.
 *
 * The grid cell and the exported file both need this sentence and must not
 * disagree about it — an export is read away from the screen that produced it,
 * so "Moved to next day ×3" in the file has to mean what the row said.
 *
 * The count is of every carry-forward the lead has ever had, not only the
 * current one, because that is the useful number: a lead moved eight times is a
 * lead nobody is getting to, and its current row alone cannot say so. Returns
 * '' for a lead nobody holds, so the caller decides how to show nothing.
 */
export function movementLabel(lead: Pick<Lead, 'assignmentType' | 'carriedForwardCount' | 'assignedTo'>): string {
  const moved = lead.carriedForwardCount ?? 0;
  const timesMoved = moved === 1 ? 'moved to next day once' : `moved to next day ${moved}×`;
  if (lead.assignmentType === 'carry_forward') {
    return moved > 1 ? `Moved to next day (${moved}×)` : 'Moved to next day';
  }
  if (lead.assignmentType === 'reassignment') return moved ? `Reassigned · ${timesMoved}` : 'Reassigned';
  if (lead.assignmentType === 'new_assignment') return moved ? `Assigned · ${timesMoved}` : 'Assigned';
  // No assignment row: either the lead has no owner, or it was assigned by a
  // route that predates the history table and hasn't been re-stamped yet.
  return lead.assignedTo ? 'Assigned' : '';
}

/**
 * One entry in a lead's comment trail. Manual edits and call notes share the same
 * feed; `source` says which one it came from.
 */
export interface LeadComment {
  id: string;
  text: string;
  at: string;
  user: string;
  source: 'Manual Update' | 'Call Notes';
}

/** One handover in a lead's ownership history. */
export interface LeadAssignment {
  id: string;
  leadId: string;
  leadName: string;
  /**
   * The lead's own time zone, repeated on every row so each stamp below can be
   * read on the LEAD's clock. Null when the lead has no zone set, which is the
   * one case that falls back to the reader's.
   */
  timezone: string | null;
  /** Null on a first assignment — there was nobody to take it from. */
  previousEmployee: string | null;
  newEmployee: string;
  assignedBy: string;
  assignedAt: string;
  /**
   * `carry_forward` is not a handover: nobody moved the lead, an automatic sweep
   * re-stamped it for a new day because its work was still outstanding. It is a
   * separate type precisely so the trail can say so, and so the once-a-day
   * reassignment lock can ignore it.
   */
  type: 'new_assignment' | 'reassignment' | 'carry_forward';
  remarks: string | null;
  /** The row naming the lead's owner right now. */
  current: boolean;
}

export interface LeadActivity {
  id: string;
  action: string;
  oldValue: string | null;
  newValue: string | null;
  remarks?: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
  lead: { id: string; businessName: string } | null;
}

export interface QuoSyncLog {
  id: string;
  success: boolean;
  statusCode: number | null;
  request: unknown;
  response: unknown;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface CreateLeadInput {
  businessName: string;
  phone: string;
  email?: string;
  state: string;
  city: string;
  timezone?: string;
  // ── Lead sheet fields ──
  contactName?: string;
  industry?: string;
  title?: string;
  employeeCode?: string;
  comments?: string;
  leadCategory?: string;
  nextFollowUpDate?: string;
  callStatus?: string;
  firstContact?: string;
  lastContact?: string;
  followupCount?: number;
  meetingDate?: string;
  lostReason?: string;
  caller?: string;
  leadId?: string;
  leadGenerationId?: string;
  leadSource?: string;
  contactName2?: string;
  altPhone?: string;
  website?: string;
  socialMedia?: string;
  country?: string;
  companySize?: string;
  foundedYear?: string;
  address?: string;
}

/** Lead edit payload — any subset of the create fields, plus editable status. */
export type UpdateLeadInput = Partial<CreateLeadInput> & { status?: string };

/** Everything the list can be narrowed, ordered and paged by — all of it applied
 *  by the API, so a caller only ever receives the rows it is going to show. */
export interface LeadListQuery {
  mine?: boolean;
  closed?: boolean;
  fromLeadId?: string;
  toLeadId?: string;
  limit?: number;
  q?: string;
  status?: string;
  state?: string;
  city?: string;
  timezone?: string;
  callStatus?: string;
  assigned?: 'assigned' | 'unassigned';
  /**
   * One employee's leads. Different question from `assigned`, which asks only
   * whether a lead has an owner. Admin-only — the API ignores it for every
   * other role, so sending it can never widen what somebody may see.
   */
  employeeId?: string;
  createdFrom?: string;
  createdTo?: string;
  /**
   * Which lead date the `createdFrom`/`createdTo` range applies to.
   *
   * `created` (the default) is when the lead was first created; `scheduled` is
   * the day it is currently queued for. Filtering a day on `created` and reading
   * it as "today's leads" quietly omits every lead created earlier and carried
   * forward into today — which is most of a working day, and was missing from
   * the export along with it.
   */
  dateField?: 'created' | 'scheduled';
  /** Closed Leads dates rows by when they closed, not when they were created. */
  closedFrom?: string;
  closedTo?: string;
  closedBy?: string;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  idsOnly?: boolean;
}

/** One page, and how many rows there are behind it. */
export interface LeadPage {
  rows: Lead[];
  total: number;
  page: number;
  pageSize: number;
}

const LIST_KEYS: (keyof LeadListQuery)[] = [
  'mine', 'closed', 'fromLeadId', 'toLeadId', 'limit', 'q', 'status', 'state', 'city',
  'timezone', 'callStatus', 'assigned', 'employeeId', 'createdFrom', 'createdTo', 'dateField', 'closedFrom', 'closedTo',
  'closedBy', 'page', 'pageSize', 'sortBy', 'sortDir', 'idsOnly',
];

/** A saved lead that matches the record being created, and on what. */
export interface DuplicateMatch {
  id: string;
  leadId: string;
  businessName: string;
  phone: string;
  altPhone: string | null;
  email: string | null;
  website: string | null;
  status: string;
  assignedTo: string | null;
  createdAt: string;
  /** `Phone`, `Email`, `Company Domain`, `Location`. */
  matchedOn: string[];
}

// ── Duplicate Leads scan ──
/** Same rule the import uses; see the API's lead-dedupe.ts. */
export interface DuplicateScanOptions {
  /** `phone`, `email`, or both. Empty compares both. */
  checkFields?: string[];
  ignorePhoneFormatting?: boolean;
  matchCompanyDomain?: boolean;
  /** Compare business name + city + state, all three together. */
  matchLocation?: boolean;
  limit?: number;
}
export interface DuplicateGroupLead {
  id: string;
  leadId: string;
  businessName: string;
  phone: string;
  altPhone: string | null;
  email: string | null;
  website: string | null;
  contactName: string | null;
  city: string | null;
  state: string | null;
  status: string;
  assignedTo: string | null;
  createdAt: string;
  /** How many key columns this record actually fills in. */
  filled: number;
}
export interface DuplicateGroup {
  size: number;
  /** `Phone`, `Email`, `Company Domain`, `Location` — whichever bind this group. */
  matchedOn: string[];
  /** Oldest first, then most complete. */
  leads: DuplicateGroupLead[];
}
export interface DuplicateScanResult {
  scanned: number;
  totalGroups: number;
  /** What keeping one record per group would clear. */
  redundantLeads: number;
  returned: number;
  groups: DuplicateGroup[];
}

export const leadsApi = {
  // `mine` narrows the result to the caller's OWN assigned leads whatever their
  // role — managers included, who otherwise see every lead. Employees are scoped
  // to their own book by the API regardless, so they never need the flag.
  // `closed` splits the two lead modules: false lists the active book, true the
  // Closed Leads module (scoped for employees to the leads they closed). Omit
  // both to list every record the caller may see.
  //
  // Returns ONE PAGE plus the total. It used to return an array of up to a
  // thousand leads and leave the browser to filter, sort and paginate them,
  // which is why opening Lead Management meant downloading the book first.
  //
  // `signal` is optional and comes from React Query: when the caller's query key
  // changes — a filter, a sort, another keystroke in the search box — the
  // request this replaces is aborted instead of being left to finish and be
  // discarded. Without it a burst of filter changes leaves that many requests in
  // flight, queued behind each other on one connection, and the newest answer
  // waits behind answers nobody wants.
  page: async (opts?: LeadListQuery, signal?: AbortSignal): Promise<LeadPage> => {
    const params: Record<string, string | number | boolean> = {};
    for (const k of LIST_KEYS) {
      const v = opts?.[k];
      if (v === undefined || v === '' || v === false) continue;
      params[k] = typeof v === 'string' ? v.trim() : v;
    }
    // `closed` is meaningful when false — it is what selects Lead Management
    // over Closed Leads — so it can't be dropped with the other falsy values.
    if (opts?.closed !== undefined) params.closed = opts.closed;
    return (await api.get('/leads', { params: Object.keys(params).length ? params : undefined, signal })).data;
  },

  /** The rows alone, for callers that want a bounded list and no page state. */
  list: async (opts?: LeadListQuery, signal?: AbortSignal): Promise<Lead[]> => (await leadsApi.page(opts, signal)).rows,

  /**
   * The values behind the timezone / state / city dropdowns.
   *
   * Asked for directly rather than derived from the rows on screen: with the
   * list paginated the current page holds a few dozen leads, and a filter built
   * from those would offer only the cities that happen to be on it.
   */
  filterOptions: async (opts?: Pick<LeadListQuery, 'closed' | 'timezone' | 'state'>, signal?: AbortSignal): Promise<{ timezones: string[]; states: string[]; cities: string[]; closers: string[] }> => {
    const params: Record<string, string | boolean> = {};
    if (opts?.closed !== undefined) params.closed = opts.closed;
    if (opts?.timezone) params.timezone = opts.timezone;
    if (opts?.state) params.state = opts.state;
    return (await api.get('/leads/filter-options', { params: Object.keys(params).length ? params : undefined, signal })).data;
  },
  get: async (id: string): Promise<Lead> => (await api.get(`/leads/${id}`)).data,
  activities: async (id: string): Promise<LeadActivity[]> => (await api.get(`/activities/lead/${id}`)).data,
  /** Create a lead. Rejects with a 409 carrying `duplicates` when one already
   *  matches on phone or email — resend with `allowDuplicate` to override. */
  create: async (input: CreateLeadInput & { allowDuplicate?: boolean }): Promise<Lead> =>
    (await api.post('/leads', input)).data,
  /** Leads matching one record, for warning before a create is attempted. */
  checkDuplicate: async (rec: {
    phone?: string; altPhone?: string; email?: string; website?: string; excludeId?: string;
    // Compared only together, and only when `matchLocation` asks for them.
    businessName?: string; city?: string; state?: string;
    matchCompanyDomain?: boolean; matchLocation?: boolean;
  }): Promise<DuplicateMatch[]> => (await api.post('/leads/check-duplicate', rec)).data,
  // Managers-only edit. Any subset of fields; `status` and `caller` (reassign)
  // are accepted in addition to the create fields.
  update: async (id: string, input: UpdateLeadInput): Promise<Lead> => (await api.patch(`/leads/${id}`, input)).data,
  /** Complete ownership trail for a lead, newest first. Never rewritten — each
   *  handover appends a row, so this is the audit trail of who assigned the
   *  lead, when, from whom, to whom, and why. */
  assignmentHistory: async (id: string): Promise<LeadAssignment[]> => (await api.get(`/leads/${id}/assignments`)).data,

  /** Comment trail (manual edits + call notes), newest first. */
  commentHistory: async (id: string): Promise<LeadComment[]> => (await api.get(`/leads/${id}/comments`)).data,
  /** Delete many leads in one transaction — PERMANENT, cascades to calls, notes
   *  and activities. Import rollback posts the import's createdIds here. */
  bulkDelete: async (ids: string[]): Promise<{ deleted: number }> => (await api.post('/leads/bulk-delete', { ids })).data,
  /** Remove many leads reversibly — the duplicate purge. Returns the ids it
   *  actually archived, which is what `bulkRestore` undoes. */
  bulkArchive: async (ids: string[]): Promise<{ archived: number; ids: string[] }> =>
    (await api.post('/leads/bulk-archive', { ids })).data,
  /** Put an archived batch back. */
  bulkRestore: async (ids: string[]): Promise<{ restored: number }> =>
    (await api.post('/leads/bulk-restore', { ids })).data,
  /** Duplicate groups among saved leads — read-only; removal goes via bulkDelete. */
  duplicates: async (opts: DuplicateScanOptions = {}): Promise<DuplicateScanResult> =>
    (await api.get('/leads/duplicates', {
      params: {
        ...(opts.checkFields?.length ? { checkFields: opts.checkFields.join(',') } : {}),
        ...(opts.ignorePhoneFormatting ? { ignorePhoneFormatting: 'true' } : {}),
        ...(opts.matchCompanyDomain ? { matchCompanyDomain: 'true' } : {}),
        ...(opts.matchLocation ? { matchLocation: 'true' } : {}),
        ...(opts.limit ? { limit: opts.limit } : {}),
      },
    })).data,
  remove: async (id: string) => (await api.delete(`/leads/${id}`)).data,
  syncToQuo: async (id: string) => (await api.post(`/leads/${id}/quo-sync`)).data,
  syncAllToQuo: async (): Promise<{ total: number; synced: number; failed: number; sandbox: boolean }> =>
    (await api.post('/leads/quo-sync-all')).data,
  quoLogs: async (id: string): Promise<QuoSyncLog[]> => (await api.get(`/leads/${id}/quo-logs`)).data,
};
