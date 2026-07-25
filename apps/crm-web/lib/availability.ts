import { api } from './api';

export type Availability = 'online' | 'offline';
export type ReassignType = 'call' | 'callback' | 'followup' | 'zoom' | 'task';

export interface AvailabilityStatus {
  availability: Availability;
  reason: string | null;
  lastLoginAt: string | null;
}

export interface Reassignment {
  id: string;
  type: ReassignType;
  reason: string;
  fromUserId: string;
  fromUserName: string;
  toUserId: string;
  leadId: string | null;
  zoomMeetingId: string | null;
  taskId: string | null;
  clientName: string | null;
  scheduledAt: string | null;
  acknowledged: boolean;
  createdAt: string;
}

export const REASSIGN_LABEL: Record<ReassignType, string> = {
  call: 'Call',
  callback: 'Callback',
  followup: 'Follow-up',
  zoom: 'Zoom Meeting',
  task: 'Task',
};

export const OFFLINE_REASONS = ['Leave', 'Holiday', 'Unavailable'];

export const availabilityApi = {
  status: async (): Promise<AvailabilityStatus> => (await api.get('/availability')).data,
  setOffline: async (reason?: string) => (await api.post('/availability/offline', { reason })).data,
  setOnline: async () => (await api.post('/availability/online')).data,
  signOut: async () => (await api.post('/availability/sign-out')).data,
  inbox: async (): Promise<Reassignment[]> => (await api.get('/availability/inbox')).data,
  ack: async (id: string) => (await api.post(`/availability/inbox/${id}/ack`)).data,
  /** Admin-only: set another user's availability. Offline reassigns their work. */
  adminSet: async (userId: string, online: boolean, reason?: string) =>
    (await api.post(`/availability/user/${userId}`, { online, reason })).data,
};
