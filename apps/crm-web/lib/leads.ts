import { api } from './api';

export type QuoStatus = 'not_synced' | 'pending' | 'synced' | 'failed';

export interface Lead {
  id: string;
  leadId: string;
  businessName: string;
  phone: string;
  email: string | null;
  state: string;
  city: string;
  timezone: string;
  status: string;
  // ── Lead sheet fields ──
  contactName: string | null;
  industry: string | null;
  title: string | null;
  employeeCode: string | null;
  comments: string | null;   // latest remark; full trail via leadsApi.commentHistory
  /** When the lead last changed hands. Same-day = locked until tomorrow. */
  assignedAt?: string | null;

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
  /** Null on a first assignment — there was nobody to take it from. */
  previousEmployee: string | null;
  newEmployee: string;
  assignedBy: string;
  assignedAt: string;
  type: 'new_assignment' | 'reassignment';
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
  createdFrom?: string;
  createdTo?: string;
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
  'timezone', 'callStatus', 'assigned', 'createdFrom', 'createdTo', 'closedFrom', 'closedTo',
  'closedBy', 'page', 'pageSize', 'sortBy', 'sortDir', 'idsOnly',
];

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
  page: async (opts?: LeadListQuery): Promise<LeadPage> => {
    const params: Record<string, string | number | boolean> = {};
    for (const k of LIST_KEYS) {
      const v = opts?.[k];
      if (v === undefined || v === '' || v === false) continue;
      params[k] = typeof v === 'string' ? v.trim() : v;
    }
    // `closed` is meaningful when false — it is what selects Lead Management
    // over Closed Leads — so it can't be dropped with the other falsy values.
    if (opts?.closed !== undefined) params.closed = opts.closed;
    return (await api.get('/leads', { params: Object.keys(params).length ? params : undefined })).data;
  },

  /** The rows alone, for callers that want a bounded list and no page state. */
  list: async (opts?: LeadListQuery): Promise<Lead[]> => (await leadsApi.page(opts)).rows,

  /**
   * The values behind the timezone / state / city dropdowns.
   *
   * Asked for directly rather than derived from the rows on screen: with the
   * list paginated the current page holds a few dozen leads, and a filter built
   * from those would offer only the cities that happen to be on it.
   */
  filterOptions: async (opts?: Pick<LeadListQuery, 'closed' | 'timezone' | 'state'>): Promise<{ timezones: string[]; states: string[]; cities: string[]; closers: string[] }> => {
    const params: Record<string, string | boolean> = {};
    if (opts?.closed !== undefined) params.closed = opts.closed;
    if (opts?.timezone) params.timezone = opts.timezone;
    if (opts?.state) params.state = opts.state;
    return (await api.get('/leads/filter-options', { params: Object.keys(params).length ? params : undefined })).data;
  },
  get: async (id: string): Promise<Lead> => (await api.get(`/leads/${id}`)).data,
  activities: async (id: string): Promise<LeadActivity[]> => (await api.get(`/activities/lead/${id}`)).data,
  create: async (input: CreateLeadInput): Promise<Lead> => (await api.post('/leads', input)).data,
  // Managers-only edit. Any subset of fields; `status` and `caller` (reassign)
  // are accepted in addition to the create fields.
  update: async (id: string, input: UpdateLeadInput): Promise<Lead> => (await api.patch(`/leads/${id}`, input)).data,
  /** Complete ownership trail for a lead, newest first. Never rewritten — each
   *  handover appends a row, so this is the audit trail of who assigned the
   *  lead, when, from whom, to whom, and why. */
  assignmentHistory: async (id: string): Promise<LeadAssignment[]> => (await api.get(`/leads/${id}/assignments`)).data,

  /** Comment trail (manual edits + call notes), newest first. */
  commentHistory: async (id: string): Promise<LeadComment[]> => (await api.get(`/leads/${id}/comments`)).data,
  /** Delete many leads in one transaction. Import rollback posts the import's createdIds here. */
  bulkDelete: async (ids: string[]): Promise<{ deleted: number }> => (await api.post('/leads/bulk-delete', { ids })).data,
  remove: async (id: string) => (await api.delete(`/leads/${id}`)).data,
  syncToQuo: async (id: string) => (await api.post(`/leads/${id}/quo-sync`)).data,
  syncAllToQuo: async (): Promise<{ total: number; synced: number; failed: number; sandbox: boolean }> =>
    (await api.post('/leads/quo-sync-all')).data,
  quoLogs: async (id: string): Promise<QuoSyncLog[]> => (await api.get(`/leads/${id}/quo-logs`)).data,
};
