import { api } from './api';

export type UserRole = 'admin' | 'team_leader' | 'employee';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  mfaEnabled?: boolean;
  availability?: 'online' | 'offline';
  shiftStart?: string | null;
  /** OpenPhone number this caller sends SMS / dials from (E.164). */
  openphoneNumber?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateUserInput {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  openphoneNumber?: string;
}

export interface UpdateUserInput {
  name?: string;
  email?: string;
  role?: UserRole;
  isActive?: boolean;
  /** Optional — only sent when changing the password. */
  password?: string;
  /** Shift start "HH:mm" (or '' to clear) — enables no-login auto-reassignment. */
  shiftStart?: string;
  /** OpenPhone number (E.164, or '' to clear). */
  openphoneNumber?: string;
}

export const usersApi = {
  list: async (): Promise<User[]> => (await api.get('/users')).data,
  create: async (input: CreateUserInput): Promise<User> => (await api.post('/users', input)).data,
  update: async (id: string, input: UpdateUserInput): Promise<User> => (await api.patch(`/users/${id}`, input)).data,
  deactivate: async (id: string): Promise<User> => (await api.delete(`/users/${id}`)).data,
  /**
   * Permanently delete an account (admin only). Irreversible, and refused with a
   * 409 for any user who has recorded work — the API's message names what is in
   * the way and is meant to be shown as-is. `deactivate` is the operation for
   * somebody who has left.
   */
  remove: async (id: string): Promise<{ id: string; deleted: boolean }> =>
    (await api.delete(`/users/${id}/permanent`)).data,
};
