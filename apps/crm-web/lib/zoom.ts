import { api } from './api';

export type ZoomMeetingStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'rescheduled';

export interface ZoomLead {
  id: string;
  leadId: string;
  businessName: string;
  phone: string;
  email: string | null;
  city: string;
  state: string;
  /** The client's zone — the one every meeting time on this record is stated in. */
  timezone: string;
  industry: string | null;
  status: string;
}
export interface ZoomOrganizer {
  id: string;
  name: string;
  email: string;
}

export interface ZoomMeeting {
  id: string;
  leadId: string;
  organizerId: string | null;
  title: string | null;
  scheduledAt: string;
  durationMins: number;
  status: ZoomMeetingStatus;
  joinUrl: string | null;
  meetingId: string | null;
  passcode: string | null;
  participants: string | null;
  startedAt: string | null;
  endedAt: string | null;
  agenda: string | null;
  reason: string | null;
  outcome: string | null;
  notes: string | null;
  summary: string | null;
  clientFeedback: string | null;
  decisions: string | null;
  actionItems: string | null;
  followUpAt: string | null;
  createdAt: string;
  updatedAt: string;
  lead: ZoomLead | null;
  organizer: ZoomOrganizer | null;
}

export interface ZoomActivity {
  id: string;
  meetingId: string;
  userId: string | null;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  remarks: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
}

export const ACTION_LABEL: Record<string, string> = {
  created: 'Meeting created',
  scheduled: 'Meeting scheduled',
  rescheduled: 'Meeting rescheduled',
  cancelled: 'Meeting cancelled',
  started: 'Meeting started',
  completed: 'Meeting completed',
  notes_updated: 'Notes updated',
  outcome_updated: 'Outcome updated',
  follow_up_created: 'Follow-up created',
  updated: 'Meeting updated',
};

export interface ZoomQuery {
  status?: ZoomMeetingStatus;
  leadId?: string;
  from?: string;
  to?: string;
  q?: string;
}

export interface CreateZoomMeeting {
  leadId: string;
  scheduledAt: string;
  title?: string;
  durationMins?: number;
  joinUrl?: string;
  meetingId?: string;
  passcode?: string;
  participants?: string;
  agenda?: string;
  reason?: string;
  organizerId?: string;
  notes?: string;
}
export type UpdateZoomMeeting = Partial<Omit<CreateZoomMeeting, 'leadId'>> & { status?: ZoomMeetingStatus };

export interface CompleteZoomMeeting {
  outcome?: string;
  agenda?: string;
  reason?: string;
  summary?: string;
  clientFeedback?: string;
  decisions?: string;
  notes?: string;
  actionItems?: string;
  followUpAt?: string;
}

export const STATUS_META: Record<ZoomMeetingStatus, { label: string; color: string }> = {
  scheduled: { label: 'Scheduled', color: 'var(--tone-blue-fg)' },
  in_progress: { label: 'In Progress', color: 'var(--tone-amber-fg)' },
  completed: { label: 'Completed', color: 'var(--brand-strong)' },
  cancelled: { label: 'Cancelled', color: 'var(--tone-red-fg)' },
  rescheduled: { label: 'Rescheduled', color: '#6b5bd1' },
};

export const zoomApi = {
  list: async (params?: ZoomQuery): Promise<ZoomMeeting[]> => (await api.get('/zoom/meetings', { params })).data,
  due: async (): Promise<ZoomMeeting[]> => (await api.get('/zoom/meetings/due')).data,
  byLead: async (leadId: string): Promise<ZoomMeeting[]> => (await api.get(`/zoom/meetings/lead/${leadId}`)).data,
  activities: async (id: string): Promise<ZoomActivity[]> => (await api.get(`/zoom/meetings/${id}/activities`)).data,
  get: async (id: string): Promise<ZoomMeeting> => (await api.get(`/zoom/meetings/${id}`)).data,
  create: async (body: CreateZoomMeeting): Promise<ZoomMeeting> => (await api.post('/zoom/meetings', body)).data,
  update: async (id: string, body: UpdateZoomMeeting): Promise<ZoomMeeting> =>
    (await api.patch(`/zoom/meetings/${id}`, body)).data,
  start: async (id: string): Promise<ZoomMeeting> => (await api.post(`/zoom/meetings/${id}/start`)).data,
  complete: async (id: string, body: CompleteZoomMeeting): Promise<ZoomMeeting> =>
    (await api.post(`/zoom/meetings/${id}/complete`, body)).data,
  cancel: async (id: string): Promise<ZoomMeeting> => (await api.post(`/zoom/meetings/${id}/cancel`)).data,
  remove: async (id: string) => (await api.delete(`/zoom/meetings/${id}`)).data,
};
