'use client';

import { useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Users, Shield, UserCheck, Phone, Check, Pencil, Filter, X, Ban, RotateCcw, Wifi, WifiOff } from 'lucide-react';
import { usersApi, type User, type UserRole } from '@/lib/users';
import { availabilityApi } from '@/lib/availability';
import { PageHead, Avatar } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { DateFilter, FilterSelect, SearchInput } from '@/components/filter-controls';
import { DataTable, useColumnPrefs, type ColumnDef } from '@/components/data-table';
import { inDateBounds, EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';

const ROLE_META: Record<string, { label: string; cls: string; desc: string; perms: string[] }> = {
  admin: { label: 'Admin', cls: 'bg-[#f7e3da] text-[#a8431f]', desc: 'Full access to all modules, data, settings, and user management.', perms: ['All modules & settings', 'User management', 'Recordings & exports', 'System configuration'] },
  team_leader: { label: 'Team Leader', cls: 'bg-[#dff0ec] text-[#2f6f63]', desc: 'Assign leads, monitor team performance, and view team reports.', perms: ['Assign & distribute leads', 'Monitor live team', 'Team reports & recordings', 'No system settings'] },
  employee: { label: 'Sales Caller', cls: 'bg-[#d8eed9] text-[#266929]', desc: 'Work assigned leads — update status, add notes, and log calls.', perms: ['Assigned leads only', 'Make & log calls', 'Add notes & follow-ups', 'No team data access'] },
};

const ROLE_OPTS = [
  { label: 'All Roles', value: '' },
  { label: 'Admin', value: 'admin' },
  { label: 'Team Leader', value: 'team_leader' },
  { label: 'Sales Caller', value: 'employee' },
];
const ROLE_SELECT: { label: string; value: UserRole }[] = [
  { label: 'Admin', value: 'admin' },
  { label: 'Team Leader', value: 'team_leader' },
  { label: 'Sales Caller', value: 'employee' },
];

export default function UsersPage() {
  const qc = useQueryClient();
  const { data: users = [] } = useQuery<User[]>({ queryKey: ['users'], queryFn: usersApi.list, retry: false });
  const [role, setRole] = useState('');
  const [dateRange, setDateRange] = useState<DateFilterValue>(EMPTY_DATE_FILTER);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const count = (r: string) => users.filter((u) => u.role === r).length;

  const toggleActive = useMutation({
    mutationFn: (u: User) => usersApi.update(u.id, { isActive: !u.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  // Bulk deactivate (soft): the API has no hard-delete, so "Delete" deactivates.
  const deactivateUsers = useMutation({
    mutationFn: async (rows: User[]) => { for (const u of rows.filter((x) => x.isActive)) await usersApi.deactivate(u.id); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  // Admin availability override (Online/Offline). Offline reassigns the user's
  // pending work, so it's confirmed before firing.
  const setAvail = useMutation({
    mutationFn: ({ u, online }: { u: User; online: boolean }) => availabilityApi.adminSet(u.id, online),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  // Refs keep the column defs stable while still calling the latest handlers.
  const editRef = useRef<(u: User) => void>(() => {});
  const toggleRef = useRef<(u: User) => void>(() => {});
  const availRef = useRef<(u: User) => void>(() => {});
  editRef.current = (u) => setEditing(u);
  toggleRef.current = (u) => toggleActive.mutate(u);
  availRef.current = (u) => {
    const online = (u.availability ?? 'online') === 'online';
    if (online && !confirm(`Mark ${u.name} offline? Their pending leads, callbacks and tasks will be reassigned to the next available caller.`)) return;
    setAvail.mutate({ u, online: !online });
  };

  const columns = useMemo<ColumnDef<User>[]>(() => [
    {
      key: 'user', header: 'User', required: true, searchable: true,
      searchValue: (u) => `${u.name} ${u.email}`,
      render: (u) => <div className="flex items-center gap-[10px]"><Avatar name={u.name} /><div><div className="font-semibold">{u.name}</div><div className="text-[11.5px] text-muted-foreground">{u.email}</div></div></div>,
    },
    { key: 'role', header: 'Role', trackable: true, render: (u) => <span className={`rounded-full px-2.5 py-[3px] text-[11.5px] font-bold ${ROLE_META[u.role].cls}`}>{ROLE_META[u.role].label}</span> },
    { key: 'status', header: 'Status', trackable: true, render: (u) => <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11.5px] font-semibold ${u.isActive ? 'bg-[#d8eed9] text-[#266929]' : 'bg-[#e7f0f8] text-[#2c5d8f]'}`}><span className="h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} />{u.isActive ? 'Active' : 'Inactive'}</span> },
    {
      key: 'availability', header: 'Availability', trackable: true,
      render: (u) => {
        const online = (u.availability ?? 'online') === 'online';
        return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11.5px] font-semibold ${online ? 'bg-[#d8eed9] text-[#266929]' : 'bg-[#fbeeec] text-[#9e2b21]'}`}><span className="h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} />{online ? 'Online' : 'Offline'}</span>;
      },
    },
    { key: 'shift', header: 'Shift', trackable: true, render: (u) => u.shiftStart ? <span className="font-mono text-[12px]">{u.shiftStart}</span> : <span className="text-muted-foreground">—</span> },
    { key: 'openphone', header: 'OpenPhone #', searchable: true, searchValue: (u) => u.openphoneNumber, render: (u) => u.openphoneNumber ? <span className="font-mono text-[12px]">{u.openphoneNumber}</span> : <span className="text-muted-foreground">—</span> },
    { key: 'created', header: 'Created', cellClassName: 'text-muted-foreground', render: (u) => new Date(u.createdAt).toLocaleDateString() },
    {
      key: 'actions', header: '', required: true, headerClassName: 'text-right', cellClassName: 'text-right',
      render: (u) => (
        <div className="flex justify-end gap-1.5">
          <button onClick={() => editRef.current(u)} title="Edit user" className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil className="h-4 w-4" /></button>
          {(() => {
            const online = (u.availability ?? 'online') === 'online';
            return (
              <button onClick={() => availRef.current(u)} title={online ? 'Set offline (reassigns their work)' : 'Set online'} className={`grid h-8 w-8 place-items-center rounded-lg hover:bg-muted ${online ? 'text-muted-foreground hover:text-[#9e2b21]' : 'text-[#317d34]'}`}>
                {online ? <WifiOff className="h-4 w-4" /> : <Wifi className="h-4 w-4" />}
              </button>
            );
          })()}
          <button onClick={() => toggleRef.current(u)} title={u.isActive ? 'Deactivate' : 'Activate'} className={`grid h-8 w-8 place-items-center rounded-lg hover:bg-muted ${u.isActive ? 'text-muted-foreground hover:text-[#9e2b21]' : 'text-[#317d34]'}`}>
            {u.isActive ? <Ban className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
          </button>
        </div>
      ),
    },
  ], []);

  // Shared column prefs so the search honors the user's Searchable config.
  const prefs = useColumnPrefs('users', columns);
  const term = q.trim().toLowerCase();
  const searchCols = useMemo(() => columns.filter((c) => c.searchable), [columns]);
  const shown = users.filter(
    (u) =>
      (!role || u.role === role) &&
      inDateBounds(u.createdAt, dateRange) &&
      (!term ||
        searchCols.some(
          (c) => prefs.searchable.has(c.key) && String(c.searchValue?.(u) ?? '').toLowerCase().includes(term),
        )),
  );

  return (
    <div>
      <PageHead>
        <button onClick={() => setCreating(true)} className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[13px] font-semibold text-primary-foreground hover:opacity-90"><Plus className="h-4 w-4" /> Add User</button>
      </PageHead>

      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <KpiCard icon={Users} iconBg="#d8eed9" iconColor="#266929" value={users.length} label="Total Users" />
        <KpiCard icon={Shield} iconBg="#fdecdc" iconColor="#c98a18" value={count('admin')} label="Admins" />
        <KpiCard icon={UserCheck} iconBg="#dff0ec" iconColor="#2f6f63" value={count('team_leader')} label="Team Leaders" />
        <KpiCard icon={Phone} iconBg="#d8eed9" iconColor="#266929" value={count('employee')} label="Sales Callers" />
      </div>

      <div className="mb-5 grid gap-[18px] md:grid-cols-3">
        {Object.entries(ROLE_META).map(([r, m]) => (
          <div key={r} className="rounded-2xl border bg-card p-[18px] shadow-sm">
            <div className="mb-2.5 flex items-center justify-between"><span className={`rounded-full px-2.5 py-[3px] text-[11.5px] font-bold ${m.cls}`}>{m.label}</span><span className="text-[12px] text-muted-foreground">{count(r)} {count(r) === 1 ? 'user' : 'users'}</span></div>
            <div className="mb-3.5 text-[13px] text-muted-foreground">{m.desc}</div>
            <div className="flex flex-col gap-2.5">{m.perms.map((p) => <div key={p} className="flex items-center gap-2.5 text-[13px] font-medium"><Check className="h-[15px] w-[15px] shrink-0 text-[#317d34]" />{p}</div>)}</div>
          </div>
        ))}
      </div>

      <DataTable
        tableKey="users"
        columns={columns}
        rows={shown}
        getRowKey={(u) => u.id}
        title="All Users"
        subtitle={`${shown.length} ${shown.length === 1 ? 'member' : 'members'}`}
        emptyText={users.length === 0 ? 'Could not load users (admin role required).' : 'No users match the current filters.'}
        prefs={prefs}
        selectable
        onEditSelected={(rows) => setEditing(rows[0])}
        onDeleteSelected={(rows) => deactivateUsers.mutateAsync(rows)}
        deleteLabel="Deactivate"
        deleteConfirm={(rows) => `Deactivate ${rows.length} user${rows.length > 1 ? 's' : ''}? They won’t be able to sign in until reactivated.`}
        toolbar={
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Search name or email…" className="min-w-[220px]" />
            <FilterSelect icon={Filter} value={role} onChange={setRole} options={ROLE_OPTS} />
            <DateFilter value={dateRange} onChange={setDateRange} />
          </>
        }
      />

      {(creating || editing) && (
        <UserModal
          user={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { qc.invalidateQueries({ queryKey: ['users'] }); setCreating(false); setEditing(null); }}
        />
      )}
    </div>
  );
}

function UserModal({ user, onClose, onSaved }: { user: User | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!user;
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>(user?.role ?? 'employee');
  const [isActive, setIsActive] = useState(user?.isActive ?? true);
  const [shiftStart, setShiftStart] = useState(user?.shiftStart ?? '');
  const [openphoneNumber, setOpenphoneNumber] = useState(user?.openphoneNumber ?? '');

  const save = useMutation({
    mutationFn: () =>
      isEdit
        ? usersApi.update(user!.id, { name, email, role, isActive, shiftStart, openphoneNumber, ...(password ? { password } : {}) })
        : usersApi.create({ name, email, password, role, ...(openphoneNumber.trim() ? { openphoneNumber } : {}) }),
    onSuccess: onSaved,
  });

  const err = save.error as { response?: { data?: { message?: string | string[] } } } | undefined;
  const errMsg = err?.response?.data?.message
    ? Array.isArray(err.response.data.message) ? err.response.data.message.join(', ') : err.response.data.message
    : save.isError ? 'Could not save user.' : null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border bg-card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-display text-[16px] font-semibold">{isEdit ? 'Edit User' : 'Add User'}</h3>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
        </div>

        <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-3">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">{isEdit ? 'New Password ' : 'Password'}{isEdit && <span className="text-muted-foreground">(leave blank to keep)</span>}</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required={!isEdit} minLength={8} placeholder={isEdit ? '••••••••' : 'Min 8 characters'} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Role</span>
            <select value={role} onChange={(e) => setRole(e.target.value as UserRole)} className="w-full rounded-md border bg-background px-3 py-2 text-sm">
              {ROLE_SELECT.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">OpenPhone number <span className="text-muted-foreground">(E.164 — the number this caller sends SMS / dials from; blank = use workspace default)</span></span>
            <input value={openphoneNumber} onChange={(e) => setOpenphoneNumber(e.target.value)} placeholder="+15551234567" className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm" />
          </label>
          {isEdit && (
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Shift start <span className="text-muted-foreground">(enables no-login auto-reassignment; blank = off)</span></span>
              <input type="time" value={shiftStart} onChange={(e) => setShiftStart(e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
            </label>
          )}
          {isEdit && (
            <label className="flex items-center gap-2.5 text-sm">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 accent-[#266929]" />
              <span className="font-medium">Active</span>
            </label>
          )}

          {errMsg && <p className="text-[13px] text-[#9e2b21]">{errMsg}</p>}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded-md border bg-card px-4 py-2 text-[13px] font-semibold hover:bg-muted">Cancel</button>
            <button type="submit" disabled={save.isPending} className="rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground disabled:opacity-60">
              {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create user'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
