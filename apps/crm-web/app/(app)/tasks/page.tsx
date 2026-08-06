'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, ChevronRight, X, Filter } from 'lucide-react';
import { tasksApi, type Task, type TaskStatus } from '@/lib/crm';
import { PageHead, Avatar } from '@/components/page-head';
import { DateFilter, FilterSelect } from '@/components/filter-controls';
import { inDateBounds, EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';

const COLS: { key: TaskStatus; name: string; color: string }[] = [
  { key: 'todo', name: 'To Do', color: 'var(--tone-blue-fg)' },
  { key: 'in_progress', name: 'In Progress', color: 'var(--tone-amber-fg)' },
  { key: 'review', name: 'Review', color: 'var(--tone-teal-fg)' },
  { key: 'done', name: 'Done', color: 'var(--brand-strong)' },
];
const NEXT: Record<TaskStatus, TaskStatus | null> = { todo: 'in_progress', in_progress: 'review', review: 'done', done: null };
const PRI_STYLE: Record<string, string> = { high: 'bg-[var(--tone-red-bg)] text-[var(--tone-red-fg-2)]', medium: 'bg-[var(--tone-amber-bg)] text-[var(--tone-amber-fg)]', low: 'bg-muted text-muted-foreground' };

export default function TasksPage() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('');
  const [dateRange, setDateRange] = useState<DateFilterValue>(EMPTY_DATE_FILTER);
  const { data: tasks = [] } = useQuery({ queryKey: ['tasks'], queryFn: tasksApi.list });

  const create = useMutation({ mutationFn: (t: string) => tasksApi.create(t), onSuccess: () => { qc.invalidateQueries({ queryKey: ['tasks'] }); setTitle(''); setAdding(false); } });
  const move = useMutation({ mutationFn: ({ id, status }: { id: string; status: TaskStatus }) => tasksApi.setStatus(id, status), onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }) });
  const del = useMutation({ mutationFn: (id: string) => tasksApi.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }) });

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
        <DateFilter value={dateRange} onChange={setDateRange} />
        <button onClick={() => setAdding((v) => !v)} className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[12.5px] font-semibold text-primary-foreground hover:opacity-90"><Plus className="h-4 w-4" /> New task</button>
      </PageHead>

      {adding && (
        <form onSubmit={(e) => { e.preventDefault(); if (title.trim()) create.mutate(title.trim()); }} className="mb-[18px] flex gap-2.5 rounded-2xl border bg-card p-4 shadow-sm">
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title…" className="flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary" />
          <button type="submit" disabled={create.isPending} className="rounded-md bg-primary px-4 py-2 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-60">Add</button>
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
                      <button onClick={() => del.mutate(t.id)} className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-[var(--tone-red-fg)] group-hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
                    </div>
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
