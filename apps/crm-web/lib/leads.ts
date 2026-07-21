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
  comments: string | null;
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

export const leadsApi = {
  // `mine` scopes the result to the caller's own assigned leads (Lead
  // Management module). `closed` splits the two lead modules: false lists the
  // active book, true the Closed Leads module (scoped for employees to the
  // leads they closed). Omit both to list every record.
  list: async (opts?: { mine?: boolean; closed?: boolean }): Promise<Lead[]> => {
    const params: Record<string, boolean> = {};
    if (opts?.mine) params.mine = true;
    if (opts?.closed !== undefined) params.closed = opts.closed;
    return (await api.get('/leads', { params: Object.keys(params).length ? params : undefined })).data;
  },
  get: async (id: string): Promise<Lead> => (await api.get(`/leads/${id}`)).data,
  activities: async (id: string): Promise<LeadActivity[]> => (await api.get(`/activities/lead/${id}`)).data,
  create: async (input: CreateLeadInput): Promise<Lead> => (await api.post('/leads', input)).data,
  // Managers-only edit. Any subset of fields; `status` and `caller` (reassign)
  // are accepted in addition to the create fields.
  update: async (id: string, input: UpdateLeadInput): Promise<Lead> => (await api.patch(`/leads/${id}`, input)).data,
  remove: async (id: string) => (await api.delete(`/leads/${id}`)).data,
  syncToQuo: async (id: string) => (await api.post(`/leads/${id}/quo-sync`)).data,
  syncAllToQuo: async (): Promise<{ total: number; synced: number; failed: number; sandbox: boolean }> =>
    (await api.post('/leads/quo-sync-all')).data,
  quoLogs: async (id: string): Promise<QuoSyncLog[]> => (await api.get(`/leads/${id}/quo-logs`)).data,
};
