import { api } from './api';
import type { Lead } from './leads';

// ─────────────────────────── Metrics ───────────────────────────
/**
 * The dashboard's summary cards. The API decides the scope from the caller's
 * role — an employee's figures cover only their own leads and calls, an
 * admin's cover the whole organisation — so the client never asks for a scope
 * and cannot be pointed at someone else's numbers.
 */
export interface MetricsSummary {
  /** Which set of numbers these are, so the cards can be labelled honestly. */
  scope: 'organization' | 'personal';
  // ── Leads ──
  totalLeads: number;
  /** Leads that have an owner. For an employee this equals their total. */
  assignedLeads: number;
  /** Leads successfully contacted (completed call or contacted-or-beyond status). */
  contactedLeads: number;
  /** Assigned but not yet reached — total minus contacted. */
  pendingLeads: number;
  /** Leads carrying an outstanding callback or a note with a next date. */
  followUpLeads: number;
  /** Reached a real opportunity or a deal (interested or closed). */
  convertedLeads: number;
  /** Won — the same set the Closed Leads module lists. */
  closedLeads: number;
  /** Org-wide only; null on an employee's dashboard. */
  avgLeadsPerEmployee: number | null;
  // ── Calls ──
  totalCalls: number;
  /** Same definition the Calls Made dashboard uses. */
  connectedCalls: number;
  missedCalls: number;
  /** Zoom meetings still to happen. */
  scheduledCalls: number;
  /** Callbacks still owed. */
  callbackCalls: number;
  // ── Targets / rates ──
  plannedLeads: number;
  balanceLeads: number;
  /** Contacted as a % of total — per-book progress used for the employee view. */
  contactedPct: number;
  progressPct: number;
  /** Converted as a share of the book. */
  conversionPct: number;
}
export interface TimezoneCount {
  timezone: string;
  count: number;
}
export interface PivotCity {
  city: string;
  total: number;
  planned: number;
  balance: number;
  progressPct: number;
}
export interface PivotState extends Omit<PivotCity, 'city'> {
  state: string;
  cities: PivotCity[];
}
export interface PivotTimezone extends Omit<PivotCity, 'city'> {
  timezone: string;
  states: PivotState[];
}

export interface StateMetric {
  state: string;
  timezone: string;
  total: number;
  /** Leads in this state that have an owner. */
  assigned: number;
  /** Leads reached: completed call or contacted-or-beyond status. */
  contacted: number;
  planned: number;
  balance: number;
  progressPct: number;
}
export interface DailyPoint {
  date: string;
  count: number;
}
export interface BarPoint {
  name: string;
  value: number;
}

export interface MetricsRange {
  from?: string;
  to?: string;
}
export const metricsApi = {
  summary: async (params?: MetricsRange): Promise<MetricsSummary> => (await api.get('/metrics/summary', { params })).data,
  byTimezone: async (params?: MetricsRange): Promise<TimezoneCount[]> => (await api.get('/metrics/by-timezone', { params })).data,
  byState: async (params?: MetricsRange): Promise<StateMetric[]> => (await api.get('/metrics/by-state', { params })).data,
  daily: async (params?: MetricsRange): Promise<DailyPoint[]> => (await api.get('/metrics/daily', { params })).data,
  bar: async (params?: MetricsRange): Promise<BarPoint[]> => (await api.get('/metrics/bar', { params })).data,
  pivot: async (): Promise<PivotTimezone[]> => (await api.get('/metrics/pivot')).data,
};

// ─────────────────────────── Targets ───────────────────────────
export interface Target {
  id: string;
  state: string;
  city: string;
  timezone: string;
  monthlyTarget: number;
}
export const targetsApi = {
  list: async (): Promise<Target[]> => (await api.get('/targets')).data,
  upsert: async (t: Omit<Target, 'id'>) => (await api.post('/targets', t)).data,
  remove: async (id: string) => (await api.delete(`/targets/${id}`)).data,
};

// ───────────────────────── Assignments ─────────────────────────
export interface AssignmentSummary {
  unassigned: number;
  callers: { id: string; name: string; email: string; leadCount: number }[];
}
export const assignmentsApi = {
  summary: async (): Promise<AssignmentSummary> => (await api.get('/assignments/summary')).data,
  // Manually (re)assign a batch of leads to a single caller. Records history.
  manual: async (body: { leadIds: string[]; callerId: string; batchName?: string; skipAssigned?: boolean; allowReassign?: boolean }): Promise<{ assigned: number; callerId: string }> =>
    (await api.post('/assignments', body)).data,
  // Manual multi-employee distribution: each allocation names a caller and the exact leads they receive.
  batch: async (body: { allocations: { callerId: string; leadIds: string[] }[]; batchName?: string }): Promise<{ assigned: number; perCaller: Record<string, number> }> =>
    (await api.post('/assignments/batch', body)).data,
  auto: async (body: { callerIds: string[]; strategy: 'equal' | 'state' | 'timezone'; timezone?: string; state?: string }) =>
    (await api.post('/assignments/auto', body)).data,
};

// ─────────────────────────── Calls ─────────────────────────────
/**
 * Calling Panel KPIs for the logged-in rep.
 *
 * The first three describe the rep's BOOK — what they hold right now — so they
 * survive a refresh or a new shift and always satisfy
 * `assignedLeads = callsCompleted + pendingLeads`. The rest describe today's
 * sitting, and are recomputed after every lead the rep completes.
 */
export interface CallerDashboard {
  /** Leads currently assigned to this rep. */
  assignedLeads: number;
  /** Assigned leads the rep has finished (saved a disposition on, or closed). */
  callsCompleted: number;
  /** Assigned leads still to work — assignedLeads − callsCompleted. */
  pendingLeads: number;
  /** Time actually spent working today: talk time plus lead-processing time. */
  productiveSecs: number;
  /** Average talk time per finished call today. */
  avgCallSecs: number;
  /** Average time per lead worked today — used when no calls were placed. */
  avgHandleSecs: number;
  completedToday: number;
  callsToday: number;
  talkSecs: number;
}
// Outcomes are an admin-configurable list now; the slug is a free string.
export type CallOutcome = string;

/** Calls Made funnel bucket. Null = ungrouped: the status still appears in the
 *  per-status breakdown but sits outside the Cold → Warm → Hot → Closed flow. */
export type OutcomeCategory = 'cold' | 'warm' | 'hot' | 'connected' | 'closed_positive' | 'closed_negative';

/** Options for the outcome admin's bucket picker; '' clears the grouping. */
export const OUTCOME_CATEGORIES: { label: string; value: '' | OutcomeCategory }[] = [
  { label: 'Ungrouped', value: '' },
  { label: 'Cold', value: 'cold' },
  { label: 'Warm', value: 'warm' },
  { label: 'Hot', value: 'hot' },
  { label: 'Connected', value: 'connected' },
  { label: 'Closed — Won', value: 'closed_positive' },
  { label: 'Closed — Lost', value: 'closed_negative' },
];

export interface Outcome {
  id: string;
  slug: string;
  name: string;
  color: string;
  schedulesCallback: boolean;
  schedulesZoom: boolean;
  leadStatus: string | null;
  category: OutcomeCategory | null;
  sortOrder: number;
  isActive: boolean;
}
export const outcomesApi = {
  list: async (): Promise<Outcome[]> => (await api.get('/outcomes')).data,
  listAll: async (): Promise<Outcome[]> => (await api.get('/outcomes/all')).data,
  create: async (body: Partial<Outcome> & { name: string }): Promise<Outcome> =>
    (await api.post('/outcomes', body)).data,
  update: async (id: string, body: Partial<Outcome>): Promise<Outcome> =>
    (await api.patch(`/outcomes/${id}`, body)).data,
  remove: async (id: string) => (await api.delete(`/outcomes/${id}`)).data,
};

export interface Followup {
  kind: 'note' | 'lead';
  id: string;
  noteText: string;
  nextFollowupDate: string;
  completedAt: string | null;
  caller: string | null;
  lead: { id: string; businessName: string; phone: string; city: string; state: string; timezone: string; status: string; callbackAt?: string | null; callbackCompletedAt?: string | null } | null;
}

export interface OutcomeRecord {
  id: string;
  outcome: CallOutcome | null;
  createdAt: string;
  callbackAt: string | null;
  lead: { id: string; businessName: string; phone: string; status: string; timezone: string; callbackAt: string | null; callbackCompletedAt: string | null } | null;
  caller: { id: string; name: string; email: string } | null;
}

// ── Calls Made dashboard ──
/** Date range is already resolved to plain yyyy-mm-dd bounds by the UI's
 *  Day/Week/Month/Year/Custom filter, so the API only sees from/to. */
export interface CallsMadeQuery {
  from?: string;
  to?: string;
  /** Managers only — narrow to one caller. Ignored for employees. */
  userId?: string;
  // ── Lead-side filters, applied server-side ──
  // These go to the API (not applied in the browser) so the summary tiles and the
  // table describe the same calls, and so filtering covers the whole range rather
  // than only the page of rows the table has loaded.
  timezone?: string;
  state?: string;
  city?: string;
  /** 'assigned' | 'unassigned' | a lead status value. */
  leadStatus?: string;
  /** Outcome slug (falls back to the lead's legacy call status). */
  outcome?: string;
}

/** Values the Calls Made filter menus offer, for the current date + employee scope. */
export interface CallsMadeFilterOptions {
  geo: { timezone: string; state: string; city: string }[];
  /** Legacy imported call statuses still present in the data. */
  callStatuses: string[];
}

/** Per-status row of the report — every configured status, zeroes included. */
export interface CallStatusCount {
  slug: string;
  name: string;
  color: string;
  category: OutcomeCategory | null;
  count: number;
}

export interface CallsMadeStats {
  // ── Raw call volume (every call, with or without an outcome) ──
  total: number;
  outgoing: number;
  incoming: number;
  connected: number;
  missed: number;
  failed: number;
  totalDurationSecs: number;
  avgDurationSecs: number;
  connectedPct: number;
  /** Leads worked without a call — listed in the log, counted apart from `total`. */
  processed: number;
  /** Every contact in the log, dialled or not — what the table's rows total. */
  totalContacts: number;
  /** Time spent working leads in the queue. Handling time, not talk time. */
  processingSecs: number;
  avgProcessingSecs: number;
  // ── Funnel report (calls that recorded an outcome) ──
  /** Calls with an outcome — the denominator for every ratio below. */
  given: number;
  byStatus: CallStatusCount[];
  categories: { cold: number; warm: number; hot: number; connected: number; closedPositive: number; closedNegative: number };
  ratios: { callsMade: number; warm: number; hot: number; connected: number; closedPositive: number; closedNegative: number };
  coldPct: number;
  /** Null when no target applies (none set, or an open-ended date range). */
  target: { target: number; completed: number; remaining: number; metPct: number; reason: string | null } | null;
}

export interface CallTarget {
  dailyCallTarget: number;
  targetMissReason: string | null;
}

/**
 * A rep's lead book — the leads they hold, not the calls they made. Counts leads
 * assigned right now, so unlike everything else on the Calls Made dashboard it
 * does not move with the date range.
 */
export interface LeadBook {
  assigned: number;
  /** Leads that reached a terminal status (closed or rejected). */
  completed: number;
  /** Still to work: assigned − completed. */
  balance: number;
}

export interface CallRecord {
  id: string;
  /**
   * `call` — dialled. `processed` — the lead was worked from the queue with no
   * call placed (the lead-processing mode used while dialling is switched off).
   * A processed row has no duration, direction or recording, because no call
   * happened; it is in the log because the contact itself is real work.
   */
  kind: 'call' | 'processed';
  startTime: string;
  endTime: string | null;
  durationSecs: number | null;
  direction: 'inbound' | 'outbound' | null;
  status: string | null;
  outcome: string | null;
  /** Signed provider link — managers only; null for everyone else. */
  recordingUrl: string | null;
  /** Whether a recording exists. Safe for any viewer, and what the export reports. */
  hasRecording: boolean;
  lead: {
    id: string; leadId: string; businessName: string; contactName: string | null; phone: string; status: string;
    timezone: string; state: string; city: string; callStatus: string | null; assignedToId: string | null;
  } | null;
  caller: { id: string; name: string; email: string } | null;
}

// ───────────────────────── Calls pivot ─────────────────────────
/** A dimension either pivot axis can carry. Mirrors the API's CallPivotDim. */
export type CallPivotDim =
  | 'employee' | 'outcome' | 'bucket' | 'direction'
  | 'status' | 'leadStatus' | 'date' | 'weekday' | 'hour';

/** One value on an axis. `color` is set for outcomes, which configure their own. */
export interface CallPivotAxis {
  key: string;
  label: string;
  color: string | null;
}

/**
 * One populated cell, addressed by index into `rows`/`cols`. Cells carry the raw
 * ingredients rather than a finished measure, so the measure can be switched
 * without re-querying and every total is summed from counts, never from rates.
 */
export interface CallPivotCell {
  r: number;
  c: number;
  calls: number;
  /** Calls with an end time — the same "connected" the Calls Made stats use. */
  connected: number;
  secs: number;
}

export interface CallPivot {
  rows: CallPivotAxis[];
  cols: CallPivotAxis[];
  /** Sparse — cells with no calls are omitted. */
  cells: CallPivotCell[];
  scanned: number;
  /** True when the range holds more calls than one pivot may read. */
  truncated: boolean;
}

export interface CallPivotQuery extends CallsMadeQuery {
  rows: CallPivotDim;
  cols: CallPivotDim;
}

export const callsApi = {
  dashboard: async (): Promise<CallerDashboard> => (await api.get('/calls/caller/dashboard')).data,
  madeStats: async (params?: CallsMadeQuery): Promise<CallsMadeStats> =>
    (await api.get('/calls/made/stats', { params })).data,
  madeRecords: async (params?: CallsMadeQuery): Promise<CallRecord[]> =>
    (await api.get('/calls/made/records', { params })).data,
  madeFilters: async (params?: CallsMadeQuery): Promise<CallsMadeFilterOptions> =>
    (await api.get('/calls/made/filters', { params })).data,
  madePivot: async (params: CallPivotQuery): Promise<CallPivot> =>
    (await api.get('/calls/made/pivot', { params })).data,
  leadBook: async (userId?: string): Promise<LeadBook> =>
    (await api.get('/calls/made/leads', { params: userId ? { userId } : {} })).data,
  callTarget: async (userId: string): Promise<CallTarget> => (await api.get(`/calls/made/target/${userId}`)).data,
  setCallTarget: async (userId: string, body: Partial<CallTarget>): Promise<CallTarget> =>
    (await api.patch(`/calls/made/target/${userId}`, body)).data,
  myLeads: async (): Promise<Lead[]> => (await api.get('/calls/caller/leads')).data,
  followups: async (userId?: string): Promise<Followup[]> =>
    (await api.get('/calls/followups', { params: userId ? { userId } : {} })).data,
  completeFollowup: async (kind: 'note' | 'lead', id: string) => (await api.post(`/calls/followups/${kind}/${id}/complete`)).data,
  updateFollowup: async (kind: 'note' | 'lead', id: string, body: { noteText?: string; followUpAt?: string | null }) =>
    (await api.post(`/calls/followups/${kind}/${id}`, body)).data,
  outcomes: async (params?: { from?: string; to?: string; outcome?: string; userId?: string }): Promise<OutcomeRecord[]> =>
    (await api.get('/calls/outcomes', { params })).data,
  start: async (leadId: string) => (await api.post('/calls/start', { leadId })).data,
  end: async (callId: string, outcome: CallOutcome, durationSecs?: number, callbackAt?: string) =>
    (await api.post(`/calls/${callId}/end`, { outcome, durationSecs, callbackAt })).data,
  addNote: async (callId: string, noteText: string, nextFollowupDate?: string, callbackAt?: string) =>
    (await api.post(`/calls/${callId}/notes`, { noteText, nextFollowupDate, callbackAt })).data,
  /**
   * Correct the outcome on a past call, from the Outcome Records log. Re-applies
   * the lead-side disposition too, so the lead ends up where it would have been
   * had the right outcome been picked at the time. `callbackAt` is a wall clock
   * read in the lead's time zone, like every other scheduling input.
   */
  updateOutcome: async (callId: string, outcome: CallOutcome, callbackAt?: string) =>
    (await api.patch(`/calls/${callId}/outcome`, { outcome, callbackAt })).data,

  // ── Lead-processing mode (calling temporarily disabled) ──
  // Same disposition and same note trail as the two above, recorded straight
  // against the lead because no call was placed.
  /**
   * `durationSecs` is the time the agent spent on the lead in the queue — timed
   * from opening it to pressing Save. With live calling off there is no call to
   * measure, so this stands in as the duration for the log and the reports.
   */
  logLead: async (leadId: string, outcome: CallOutcome, callbackAt?: string, durationSecs?: number) =>
    (await api.post(`/calls/lead/${leadId}/log`, { outcome, callbackAt, durationSecs })).data,
  addLeadNote: async (leadId: string, noteText: string, nextFollowupDate?: string, callbackAt?: string) =>
    (await api.post(`/calls/lead/${leadId}/notes`, { noteText, nextFollowupDate, callbackAt })).data,
};

// ───────────────────────── Productivity ─────────────────────────
export interface CallerProductivity {
  id: string;
  name: string;
  email: string;
  callsToday: number;
  leadsCompleted: number;
  assigned: number;
  conversionPct: number;
  productiveSecs: number;
  workHours: number;
}
export interface TeamLive {
  kpis: {
    totalCallsToday: number;
    totalTalkSecs: number;
    conversionRate: number;
    bestPerformer: { name: string; calls: number } | null;
  };
  team: { id: string; name: string; status: string }[];
}
export interface DailySummaryRow {
  id: string;
  name: string;
  callsMade: number;
  connected: number;
  callbacks: number;
  deals: number;
}
export type Period = 'day' | 'week' | 'month';
export const productivityApi = {
  perCaller: async (period: Period = 'day'): Promise<CallerProductivity[]> => (await api.get('/productivity', { params: { period } })).data,
  teamLive: async (): Promise<TeamLive> => (await api.get('/productivity/team-live')).data,
  dailySummary: async (): Promise<DailySummaryRow[]> => (await api.get('/productivity/daily-summary')).data,
};

// ──────────────────────── Activities ───────────────────────────
export interface Activity {
  id: string;
  action: string;
  oldValue: string | null;
  newValue: string | null;
  remarks: string | null;
  ipAddress: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
  lead: { id: string; leadId: string; businessName: string } | null;
  callStatus: string | null;
  assignedTo: { id: string; name: string; email: string } | null;
}
export const activitiesApi = {
  list: async (): Promise<Activity[]> => (await api.get('/activities')).data,
  // Per-lead audit trail (admin / team-leader only — gated server-side).
  byLead: async (leadId: string): Promise<Activity[]> => (await api.get(`/activities/lead/${leadId}`)).data,
};

// ───────────────────────── Notifications ────────────────────────
export interface Notification {
  id: string;
  title: string;
  body: string;
  type: string;
  isRead: boolean;
  createdAt: string;
}
export type CallbackEmailType = 'callback_reminder' | 'callback_due' | 'callback_missed';
export interface EmailSettings {
  recipients: string[];
  types: Record<CallbackEmailType, boolean>;
}
export const notificationsApi = {
  list: async (): Promise<Notification[]> => (await api.get('/notifications')).data,
  unreadCount: async (): Promise<{ count: number }> => (await api.get('/notifications/unread-count')).data,
  markAllRead: async () => (await api.post('/notifications/read-all')).data,
  getEmailSettings: async (): Promise<EmailSettings> => (await api.get('/notifications/email-settings')).data,
  updateEmailSettings: async (s: EmailSettings): Promise<EmailSettings> =>
    (await api.put('/notifications/email-settings', s)).data,
};

// ─────────────────────────── Tasks ─────────────────────────────
export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done';
export type TaskPriority = 'high' | 'medium' | 'low';
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  createdAt: string;
}
export const tasksApi = {
  list: async (): Promise<Task[]> => (await api.get('/tasks')).data,
  create: async (title: string, priority: TaskPriority = 'medium'): Promise<Task> =>
    (await api.post('/tasks', { title, priority })).data,
  setStatus: async (id: string, status: TaskStatus): Promise<Task> =>
    (await api.patch(`/tasks/${id}`, { status })).data,
  remove: async (id: string) => (await api.delete(`/tasks/${id}`)).data,
};

// ────────────────────────── Calendar ───────────────────────────
/** The three kinds of scheduled activity the calendar consolidates. */
export type ActivityType = 'call' | 'callback' | 'zoom';

export interface CalendarEvent {
  id: string;
  day: number;
  /** Scheduled date & time. */
  date: string;
  type: ActivityType;
  /** Contact person at the company. */
  leadName: string | null;
  companyName: string;
  leadId: string;
  assignedTo: string | null;
  status: string;
  label: string;
}
export interface CalendarResult {
  events: CalendarEvent[];
  summary: { calls: number; callbacks: number; zooms: number; total: number };
}
export const calendarApi = {
  /** Scheduled activities in a window. `userId` is honoured for managers only. */
  events: async (params: { from?: string; to?: string; userId?: string } = {}): Promise<CalendarResult> =>
    (await api.get('/calendar/events', { params: clean(params) })).data,
};

// ──────────────────── Authentication (login OTP) ────────────────────
/** Admin-configurable email-OTP policy for logins. */
export interface OtpSettings {
  enabled: boolean;
  /** Address every login code is delivered to. */
  recipientEmail: string;
  expiryMinutes: number;
  maxAttempts: number;
  resendSeconds: number;
  /** Skip the code on devices that have already passed one. */
  trustDeviceEnabled: boolean;
  /** Days a device stays trusted before a fresh code is required. */
  trustDeviceDays: number;
  /** False when SMTP isn't configured — codes would never actually be delivered. */
  mailReady: boolean;
}
export const authSettingsApi = {
  get: async (): Promise<OtpSettings> => (await api.get('/auth/otp-settings')).data,
  save: async (body: Partial<Omit<OtpSettings, 'mailReady'>>): Promise<OtpSettings> =>
    (await api.put('/auth/otp-settings', body)).data,
};

// ──────────────────── Calling mode ────────────────────
/**
 * Temporary lead-processing mode. When `callingEnabled` is false the CRM places
 * no calls at all — every dial button, the Quo handoff and the queue's auto-dial
 * are switched off — while the queue itself (lead card, outcome, notes, save and
 * advance) carries on. Nothing is removed; an admin flips it back.
 */
export interface CallingMode {
  callingEnabled: boolean;
  disabledReason: string;
}
export const callingModeApi = {
  get: async (): Promise<CallingMode> => (await api.get('/communications/calling-mode')).data,
  save: async (body: Partial<CallingMode>): Promise<CallingMode> =>
    (await api.put('/communications/calling-mode', body)).data,
};

// ──────────────────── Trusted devices ────────────────────
/** A browser that has already passed an OTP and may skip it until `trustedUntil`. */
export interface TrustedDevice {
  id: string;
  deviceName: string;
  browser: string;
  os: string;
  ipAddress: string | null;
  lastLoginAt: string;
  trustedUntil: string;
  createdAt: string;
  revokedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
  /** True for the browser making the request. */
  current: boolean;
  /** Present only on the admin (all users) listing. */
  user?: { id: string; name: string; email: string };
}
export const trustedDevicesApi = {
  mine: async (): Promise<TrustedDevice[]> => (await api.get('/auth/devices')).data,
  all: async (): Promise<TrustedDevice[]> => (await api.get('/auth/devices/all')).data,
  revoke: async (id: string): Promise<{ revoked: number }> => (await api.delete(`/auth/devices/${id}`)).data,
  /** Revoke every device for a user — own account, or another's (admin only). */
  revokeAll: async (userId?: string): Promise<{ revoked: number }> =>
    (await api.delete('/auth/devices', { params: userId ? { userId } : undefined })).data,
};

// ─────────────────────────── Config ────────────────────────────
export interface ConfigStatus {
  database: { provider: string; configured: boolean };
  calling: { provider: string; configured: boolean };
  ai: { provider: string; model: string | null; configured: boolean };
  quo: { configured: boolean; sandbox: boolean };
  openphone: { provider: string; configured: boolean; sandbox: boolean };
  storage: { provider: string; configured: boolean };
  redis: { configured: boolean };
}
export const configApi = {
  status: async (): Promise<ConfigStatus> => (await api.get('/config/status')).data,
};

export interface OpenPhoneStatus {
  provider: string;
  sandbox: boolean;
  connected: boolean;
  phoneNumbers: { id: string; number: string; name?: string }[];
  error: string | null;
}
export const openphoneApi = {
  status: async (): Promise<OpenPhoneStatus> => (await api.get('/openphone/status')).data,
};

export interface TimelineItem {
  kind: 'call' | 'message' | 'note';
  id: string;
  at: string;
  direction?: 'inbound' | 'outbound';
  status?: string | null;
  durationSecs?: number | null;
  recordingUrl?: string | null;
  transcript?: string | null;
  aiSummary?: string | null;
  body?: string;
  by?: string | null;
  /** Caller identity (OpenPhone line) the call went out on. */
  from?: string | null;
}
export interface StartCallResult {
  callId: string;
  phone: string;
  status?: string;
  error?: string | null;
  /**
   * Quo app deep link for this call (`openphone://dial?…`). The UI launches the
   * app at the click site instead of using this — a custom scheme handed over
   * after an await is dropped by the browser — but it is returned so any client
   * has the canonical link, and it is never a `tel:`/browser URL.
   */
  dialUrl?: string;
  /** Caller identity the customer sees: the caller's own assigned OpenPhone line… */
  from?: string;
  /** …and their display name — shown on the widget so the agent dials as themselves. */
  callerName?: string;
}
export interface MissedCall {
  id: string;
  at: string;
  leadId: string;
  /** External lead reference (L-YYYY-N), for tracing back to the record. */
  leadRef: string;
  businessName: string;
  /** Who rang, where the lead names a contact. */
  contactName: string | null;
  phone: string;
  city: string;
  state: string;
  status: string;
  assignedTo: string | null;
  assignedToId: string;
}
export type CallPhase = 'initiated' | 'ringing' | 'connected' | 'on_hold' | 'ended';
export interface CallState {
  callId: string;
  phase: CallPhase;
  status: string | null;
  onHold: boolean;
  startedAt: string;
  endedAt: string | null;
  durationSecs: number;
  recordingUrl: string | null;
  lead: { id: string; businessName: string; phone: string; city: string; state: string };
  by: string | null;
  /** Caller identity (OpenPhone line) the call is going out on. */
  from?: string | null;
}
export const communicationsApi = {
  timeline: async (leadId: string): Promise<TimelineItem[]> =>
    (await api.get(`/communications/lead/${leadId}`)).data,
  /**
   * Send an SMS to a lead.
   *
   * The endpoint answers 200 with `{ success: false, error }` when the PROVIDER
   * rejects the message — the HTTP call succeeded, the send didn't. Callers were
   * reading that as success and reporting "Message sent" for messages that never
   * left, so the failure is raised here, once, rather than at each call site.
   */
  sendSms: async (leadId: string, body: string): Promise<{ success: boolean; error: string | null }> => {
    const res = (await api.post(`/communications/lead/${leadId}/sms`, { body })).data;
    if (!res?.success) throw new Error(res?.error || 'The message could not be sent.');
    return res;
  },
  startCall: async (leadId: string): Promise<StartCallResult> =>
    (await api.post(`/communications/lead/${leadId}/call`, {})).data,
  startCallByPhone: async (phone: string): Promise<StartCallResult & { lead: CallState['lead'] }> =>
    (await api.post(`/communications/call`, { phone })).data,
  callState: async (callId: string): Promise<CallState> =>
    (await api.get(`/communications/call/${callId}/state`)).data,
  latestIncoming: async (): Promise<IncomingCall | null> =>
    (await api.get('/communications/incoming/latest')).data,
  /**
   * Record the response to an incoming-call popup. `decline` logs the decision
   * only — OpenPhone has no call-control API, so the call is not hung up on the
   * carrier (`rejectedOnCarrier` is always false).
   */
  respondToCall: async (callId: string, action: 'attend' | 'decline'): Promise<{ ok: boolean; action: string; rejectedOnCarrier: boolean }> =>
    (await api.post(`/communications/call/${callId}/respond`, { action })).data,
  missedCalls: async (limit?: number): Promise<MissedCall[]> =>
    (await api.get('/communications/missed', { params: limit ? { limit } : undefined })).data,
  analytics: async (period = 'week'): Promise<CommAnalytics> =>
    (await api.get('/communications/analytics', { params: { period } })).data,

  // ── Calling Panel: Recordings + SMS tabs ──
  recordings: async (filters: HistoryFilters = {}): Promise<RecordedCall[]> =>
    (await api.get('/communications/recordings', { params: clean(filters) })).data,
  sms: async (filters: HistoryFilters = {}): Promise<SmsMessage[]> =>
    (await api.get('/communications/sms', { params: clean(filters) })).data,
  /** Status facets for the CURRENT filters — pass the same filters as `sms`. */
  smsStatuses: async (filters: HistoryFilters = {}): Promise<{ status: string; count: number }[]> =>
    (await api.get('/communications/sms/statuses', { params: clean(filters) })).data,

  /**
   * Recording audio as a blob URL. Fetched through axios (not a bare <audio src>)
   * because the API authenticates with a bearer token, which an <audio> element
   * cannot send — and the proxy is what keeps recordings manager-only.
   */
  recordingAudioUrl: async (recordingId: string, download = false): Promise<string> => {
    const res = await api.get(`/communications/recordings/${recordingId}/audio`, {
      params: download ? { download: '1' } : undefined,
      responseType: 'blob',
    });
    return URL.createObjectURL(res.data as Blob);
  },

  /** Full AI Summary + Transcript for a recorded call (manager or the call's owner). */
  callInsight: async (callId: string): Promise<CallInsight> =>
    (await api.get(`/communications/calls/${callId}/insight`)).data,
  /** Re-run AI summary + transcript generation for one call. */
  regenerateInsight: async (callId: string): Promise<{ callId: string; status: string }> =>
    (await api.post(`/communications/calls/${callId}/insight/regenerate`, {})).data,
  /** Queue insight generation for every recorded call missing one (admin only). */
  backfillInsights: async (): Promise<{ queued: number }> =>
    (await api.post('/communications/insights/backfill', {})).data,
  /** Progress of the insight generation queue. */
  insightsStatus: async (): Promise<InsightsStatus> =>
    (await api.get('/communications/insights/status')).data,

  syncLead: async (leadId: string): Promise<LeadSyncResult> =>
    (await api.post(`/communications/sync/lead/${leadId}`, {})).data,
  syncAll: async (): Promise<{ started: boolean; running: boolean }> =>
    (await api.post('/communications/sync/all', {})).data,
  syncStatus: async (): Promise<SyncStatus> => (await api.get('/communications/sync/status')).data,
};

/** Drop empty filter values so they aren't sent as `?search=` and rejected. */
const clean = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null));

export interface HistoryFilters {
  search?: string;
  direction?: 'inbound' | 'outbound';
  status?: string;
  from?: string;
  to?: string;
  leadId?: string;
}

export interface RecordingSegment {
  id: string;
  durationSecs: number | null;
  mimeType: string | null;
  status: string | null;
}

export interface RecordedCall {
  callId: string;
  leadId: string;
  customerName: string;
  businessName: string;
  phone: string;
  at: string;
  direction: 'inbound' | 'outbound' | null;
  status: string | null;
  durationSecs: number | null;
  by: string | null;
  /** Caller identity the call went out on. Null on legacy outbound calls placed
   *  before the line was recorded — the UI flags those. */
  from: string | null;
  recordings: RecordingSegment[];
  /** AI insight status for this call. `ready` means summary + transcript exist. */
  insight: { status: InsightStatus } | null;
}

/** Lifecycle of a call's AI insight. */
export type InsightStatus = 'none' | 'pending' | 'processing' | 'ready' | 'failed' | 'unavailable';

/** One turn of the rendered conversation transcript. */
export interface TranscriptTurn {
  speaker: 'employee' | 'customer';
  speakerName: string;
  text: string;
  startSecs: number | null;
  endSecs: number | null;
}

/** The nine structured sections of an AI call summary. */
export interface CallSummary {
  purpose: string;
  keyPoints: string[];
  customerRequirements: string[];
  questionsAsked: string[];
  employeeResponses: string[];
  decisions: string[];
  followUps: string[];
  outcome: string;
  nextSteps: string[];
}

/** Full AI insight for a call — returned when a recording's insight is opened. */
export interface CallInsight {
  callId: string;
  status: InsightStatus;
  summary: CallSummary | null;
  transcript: TranscriptTurn[] | null;
  model: string | null;
  source: string | null;
  generatedAt: string | null;
  error: string | null;
}

export interface InsightsStatus {
  running: boolean;
  queued: number;
  lastRun: { processed: number; failed: number; finishedAt: string } | null;
}

export interface SmsMessage {
  id: string;
  leadId: string | null;
  businessName: string | null;
  customerName: string | null;
  direction: 'inbound' | 'outbound';
  body: string;
  from: string;
  to: string;
  status: string | null;
  conversationId: string | null;
  at: string;
  /** CRM user who sent it (outbound only; null for inbound/legacy/synced). */
  by?: string | null;
  /** True when an outbound message went out from a line that isn't the sender's own caller ID. */
  senderMismatch?: boolean;
}

export interface LeadSyncResult {
  leadId: string;
  calls: number;
  recordings: number;
  messages: number;
  error?: string;
}

export interface SyncStatus {
  running: boolean;
  startedAt: string | null;
  lastRun: {
    conversations: number;
    skipped: number;
    leads: number;
    calls: number;
    recordings: number;
    messages: number;
    failed: number;
    sandbox: boolean;
    finishedAt: string;
  } | null;
}

export interface IncomingCall {
  callId: string;
  at: string;
  status: string | null;
  /** True once Quo reports the call as live/answered — drives popup auto-open. */
  connected: boolean;
  /** Employee who previously handled this customer (the callback is routed to them). */
  handledBy: string | null;
  handledById: string;
  /** Last logged outcome name for this customer, for recognition on callback. */
  lastOutcome: string | null;
  /** True when this customer had a callback pending (called back before it was due). */
  pendingCallback: boolean;
  lead: { id: string; businessName: string; contactName: string | null; phone: string; city: string; state: string; status: string };
}
export interface CommAnalytics {
  period: string;
  calls: { total: number; inbound: number; outbound: number; missed: number; avgDurationSecs: number; totalTalkSecs: number };
  messages: { total: number; inbound: number; outbound: number };
  series: { date: string; calls: number; messages: number }[];
}

export interface IntegrationStatus {
  openphone: { provider: string; configured: boolean; sandbox: boolean; baseUrl: string; apiKeyHint: string | null };
}
export const integrationsApi = {
  status: async (): Promise<IntegrationStatus> => (await api.get('/integrations/status')).data,
  connectOpenPhone: async (apiKey: string, baseUrl?: string, webhookSecret?: string) =>
    (await api.put('/integrations/openphone', { apiKey, baseUrl, webhookSecret })).data,
  disconnect: async (provider: 'openphone') =>
    (await api.delete(`/integrations/${provider}`)).data,
};

// ──────────────────────────── AI ───────────────────────────────
export interface AiInsights {
  bestStateToday: { state: string; timezone: string; total: number; conversionPct: number } | null;
  bestTimezone: { timezone: string; total: number; conversionPct: number } | null;
  targetPrediction: {
    totalLeads: number;
    plannedLeads: number;
    overallProgressPct: number;
    note: string;
  };
}
export const aiApi = {
  chat: async (question: string): Promise<{ answer: string; topic: string | null }> =>
    (await api.post('/ai/chat', { question })).data,
  insights: async (): Promise<AiInsights> => (await api.get('/ai/insights')).data,
};

// ────────────────────────── Import ─────────────────────────────
export interface ImportResult {
  imported: number;
  updated: number;
  skipped: number;
  totalRows: number;
  errors: { row: number; reason: string }[];
  /** Rows whose "Assigned To" employee was matched and applied. */
  /** Ids of leads this import created — post these to rollback exactly this batch. */
  createdIds: string[];
  assignedSuccessfully: number;
  /** Rows naming an employee that couldn't be matched, or a lead already owned. */
  assignmentFailed: number;
  /** Requirement 15 duplicate summary. */
  newRecords: number;
  duplicateRecords: number;
}

/** One row flagged as a duplicate by the pre-import check. */
export interface ImportDuplicateRow {
  index: number;
  matchedOn: string[];
  /** The import row's own key fields (left side of the preview grid). */
  row: { businessName: string; phone: string; email: string };
  /** The existing CRM lead it clashed with — null when it only repeats an earlier file row. */
  existing: { leadId: string; businessName: string; phone: string; email: string | null; assignedTo: string | null; createdAt: string } | null;
}
export interface ImportCheckResult {
  total: number;
  newRecords: number;
  duplicateRecords: number;
  duplicateRows: ImportDuplicateRow[];
}
export interface LeadRow {
  businessName: string;
  phone: string;
  email?: string;
  state: string;
  city: string;
  timezone?: string;
  status?: string;
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
  createdAt?: string;
}
export const importApi = {
  /** Import. `skipDuplicates` leaves out rows matching an existing lead (or an earlier file row). */
  bulk: async (rows: LeadRow[], skipDuplicates = false, skipRowIndexes?: number[], checkFields?: string[]): Promise<ImportResult> =>
    (await api.post('/leads/import', { rows, skipDuplicates, skipRowIndexes, checkFields })).data,
  /** Pre-import scan — no writes. Flags rows duplicating an existing lead by selected fields. */
  check: async (rows: LeadRow[], checkFields?: string[]): Promise<ImportCheckResult> =>
    (await api.post('/leads/import/check', { rows, checkFields })).data,
};

/** Format seconds as "5h 10m" / "2m 40s". */
export function formatDuration(secs: number): string {
  if (secs <= 0) return '0s';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
