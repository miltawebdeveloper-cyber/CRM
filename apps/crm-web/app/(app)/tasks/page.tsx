'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, ChevronRight, X, Filter, CalendarClock } from 'lucide-react';
import { tasksApi, type Task, type TaskPriority, type TaskStatus } from '@/lib/crm';
import { PageHead, Avatar } from '@/components/page-head';
import { DateFilter, FilterSelect } from '@/components/filter-controls';
import { inDateBounds, EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { getUserTimezone, userZoneAbbrev } from '@/lib/display-settings';
import { atOnClock, fromWallClock, wallClockIn } from '@/lib/calendar-grid';

const COLS: { key: TaskStatus; name: string; color: string }[] = [
  { key: 'todo', name: 'To Do', color: 'var(--tone-blue-fg)' },
  { key: 'in_progress', name: 'In Progress', color: 'var(--tone-amber-fg)' },
  { key: 'review', name: 'Review', color: 'var(--tone-teal-fg)' },
  { key: 'done', name: 'Done', color: 'var(--brand-strong)' },
];
const NEXT: Record<TaskStatus, TaskStatus | null> = { todo: 'in_progress', in_progress: 'review', review: 'done', done: null };
const PRI_STYLE: Record<string, string> = { high: 'bg-[var(--tone-red-bg)] text-[var(--tone-red-fg-2)]', medium: 'bg-[var(--tone-amber-bg)] text-[var(--tone-amber-fg)]', low: 'bg-muted text-muted-foreground' };

/**
 * Personal task board.
 *
 * A task can carry a due date and time, which puts it on the Calendar. It's
 * typed on the CRM's display clock (Settings → Display) — a task has no
 * customer, so there's no customer clock to book it on.
 */
export default function TasksPage() {
  const qc = useQueryClient();
  const tz = getUserTimezone();
  // Read once a minute, for the overdue colouring.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [due, setDue] = useState('');
  const [status, setStatus] = useState('');
  const [dateRange, setDateRange] = useState<DateFilterValue>(EMPTY_DATE_FILTER);
  const { data: tasks = [] } = useQuery({ queryKey: ['tasks'], queryFn: tasksApi.list });
  // The calendar lists due tasks, so it re-reads after any change here.
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['tasks'] }), qc.invalidateQueries({ queryKey: ['calendar'] })]);

  const create = useMutation({
    mutationFn: () => tasksApi.create(title.trim(), priority, due ? fromWallClock(due, tz)?.toISOString() : undefined),
    onSuccess: () => { void refresh(); setTitle(''); setDue(''); setPriority('medium'); setAdding(false); },
  });
  const move = useMutation({ mutationFn: ({ id, status }: { id: string; status: TaskStatus }) => tasksApi.setStatus(id, status), onSuccess: () => refresh() });
  const del = useMutation({ mutationFn: (id: string) => tasksApi.remove(id), onSuccess: () => refresh() });

  const filtered = tasks.filter((t) => (!status || t.status === status) && inDateBounds(t.createdAt, dateRange));
  const byCol = (k: TaskStatus) => filtered.filter((t: Task) => t.status === k);

  return (
    <div>
      <PageHead>
        <FilterSelect
          icon={Filter}
          value={status}
          onChange={setStatus}
          options={[
            { label: 'All Statuses', value: '' },
            ...COLS.map((c) => ({ label: c.name, value: c.key })),
          ]}
        />
        <DateFilter value={dateRange} onChange={setDateRange} iconOnly />
        <button onClick={() => setAdding((v) => !v)} className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[12.5px] font-semibold text-primary-foreground hover:opacity-90"><Plus className="h-4 w-4" /> New task</button>
      </PageHead>

      {adding && (
        <form onSubmit={(e) => { e.preventDefault(); if (title.trim()) create.mutate(); }} className="mb-[18px] flex flex-wrap items-end gap-2.5 rounded-2xl border bg-card p-4 shadow-sm">
          <label className="min-w-[200px] flex-1 text-[11.5px] font-semibold">
            Task
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title…" className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm font-normal outline-none focus:border-primary" />
          </label>
          <label className="text-[11.5px] font-semibold">
            Due <span className="font-normal text-muted-foreground">· optional, {userZoneAbbrev(tz)}</span>
            <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className="mt-1 block w-full rounded-md border bg-background px-2.5 py-[7px] text-sm font-normal" />
          </label>
          <label className="text-[11.5px] font-semibold">
            Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)} className="mt-1 block rounded-md border bg-background px-2.5 py-[9px] text-sm font-normal">
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
          <button type="submit" disabled={create.isPending || !title.trim()} className="rounded-md bg-primary px-4 py-2 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-60">Add</button>
        </form>
      )}

      <div className="grid gap-[14px] md:grid-cols-2 xl:grid-cols-4">
        {COLS.map((col) => {
          const items = byCol(col.key);
          return (
            <div key={col.key} className="min-h-[300px] rounded-2xl border bg-background p-3">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2 text-[12px] font-bold"><span className="h-[9px] w-[9px] rounded-[3px]" style={{ background: col.color }} />{col.name}</div>
                <span className="rounded-full border bg-card px-2 py-px text-[10.5px] font-bold text-muted-foreground">{items.length}</span>
              </div>
              {items.map((t) => {
                const next = NEXT[t.status];
                return (
                  <div key={t.id} className="group mb-[9px] rounded-[11px] border bg-card p-3 shadow-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-[12.5px] font-semibold leading-snug">{t.title}</div>
                      <button onClick={() => del.mutate(t.id)} aria-label={`Delete ${t.title}`} className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-[var(--tone-red-fg)] focus:opacity-100 group-hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
                    </div>
                    <DueLine task={t} tz={tz} now={now} onSaved={refresh} />
                    <div className="mt-2.5 flex items-center justify-between">
                      <span className={`rounded-full px-2 py-px text-[10px] font-semibold capitalize ${PRI_STYLE[t.priority]}`}>{t.status === 'done' ? 'Complete' : t.priority}</span>
                      <div className="flex items-center gap-2">
                        {next && <button onClick={() => move.mutate({ id: t.id, status: next })} title="Advance" className="grid h-6 w-6 place-items-center rounded-md border text-muted-foreground hover:bg-primary hover:text-primary-foreground"><ChevronRight className="h-3.5 w-3.5" /></button>}
                        <Avatar name="You" />
                      </div>
                    </div>
                  </div>
                );
              })}
              {items.length === 0 && <div className="py-6 text-center text-[11.5px] text-muted-foreground">No tasks</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A task's due time, overdue in red, and a small editor to set or move it. */
function DueLine({ task, tz, now, onSaved }: { task: Task; tz: string; now: number; onSaved: () => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(() => (task.dueDate ? wallClockIn(task.dueDate, tz) : ''));
  const save = useMutation({
    mutationFn: () => tasksApi.setDue(task.id, fromWallClock(value, tz)!.toISOString()),
    onSuccess: async () => { await onSaved(); setEditing(false); },
  });
  const overdue = !!task.dueDate && task.status !== 'done' && new Date(task.dueDate).getTime() < now;

  if (editing) {
    return (
      <form className="mt-2 flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (fromWallClock(value, tz)) save.mutate(); }}>
        <input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} aria-label={`Due date for ${task.title}`} className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-[11.5px]" required />
        <button type="submit" disabled={save.isPending || !value} className="rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground disabled:opacity-50">Save</button>
        <button type="button" onClick={() => setEditing(false)} className="rounded-md border px-2 py-1 text-[11px] font-semibold hover:bg-muted">Cancel</button>
      </form>
    );
  }
  if (task.status === 'done' && !task.dueDate) return null;
  return (
    <button
      type="button"
      onClick={() => task.status !== 'done' && setEditing(true)}
      className={`mt-2 inline-flex items-center gap-1 rounded-md text-[11px] ${task.dueDate ? (overdue ? 'font-semibold text-[var(--tone-red-fg-2)]' : 'text-muted-foreground') : 'text-muted-foreground/70'} ${task.status === 'done' ? 'cursor-default' : 'hover:text-foreground'}`}
    >
      <CalendarClock className="h-3.5 w-3.5" aria-hidden />
      {task.dueDate ? `${overdue ? 'Overdue · ' : 'Due '}${atOnClock(task.dueDate, tz)}` : 'Add due date'}
    </button>
  );
}
