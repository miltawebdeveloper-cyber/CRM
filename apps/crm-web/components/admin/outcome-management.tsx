'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks, Plus, Trash2, Check, PhoneForwarded, Video } from 'lucide-react';
import { outcomesApi, OUTCOME_CATEGORIES, type Outcome } from '@/lib/crm';

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['outcomes-all'] });
    qc.invalidateQueries({ queryKey: ['outcomes-config'] }); // pickers/filters
  };
}

function OutcomeRow({ o }: { o: Outcome }) {
  const invalidate = useInvalidate();
  const [name, setName] = useState(o.name);
  const [color, setColor] = useState(o.color);
  const [sched, setSched] = useState(o.schedulesCallback);
  const [zoom, setZoom] = useState(o.schedulesZoom);
  const [active, setActive] = useState(o.isActive);
  const [category, setCategory] = useState<string>(o.category ?? '');

  // Re-sync local state after a save (server is the source of truth).
  useEffect(() => {
    setName(o.name); setColor(o.color); setSched(o.schedulesCallback); setZoom(o.schedulesZoom); setActive(o.isActive);
    setCategory(o.category ?? '');
  }, [o.name, o.color, o.schedulesCallback, o.schedulesZoom, o.isActive, o.category]);

  const save = useMutation({
    mutationFn: () => outcomesApi.update(o.id, {
      name, color, schedulesCallback: sched, schedulesZoom: zoom, isActive: active,
      // '' means "leave it out of the funnel" — sent as null, not omitted.
      category: (category || null) as Outcome['category'],
    }),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: () => outcomesApi.remove(o.id), onSuccess: invalidate });

  const dirty = name !== o.name || color !== o.color || sched !== o.schedulesCallback || zoom !== o.schedulesZoom || active !== o.isActive || category !== (o.category ?? '');

  return (
    <div className="flex flex-wrap items-center gap-3 border-b py-2.5 last:border-0">
      <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-7 w-9 shrink-0 cursor-pointer rounded border bg-transparent" aria-label="Color" />
      <input value={name} onChange={(e) => setName(e.target.value)} className={`min-w-[160px] flex-1 rounded-md border bg-background px-2.5 py-1.5 text-[12.5px] ${active ? '' : 'opacity-50 line-through'}`} />
      <label className="flex items-center gap-1.5 text-[12px] font-medium" title="Schedules a callback (mandatory date/time, pinned, reminders)">
        <input type="checkbox" checked={sched} onChange={(e) => setSched(e.target.checked)} className="h-4 w-4 accent-[var(--brand)]" />
        <PhoneForwarded className="h-3.5 w-3.5 text-muted-foreground" /> Callback
      </label>
      <label className="flex items-center gap-1.5 text-[12px] font-medium" title="Prompts a Zoom meeting to be scheduled on this outcome">
        <input type="checkbox" checked={zoom} onChange={(e) => setZoom(e.target.checked)} className="h-4 w-4 accent-[#2D8CFF]" />
        <Video className="h-3.5 w-3.5 text-muted-foreground" /> Zoom
      </label>
      {/* Which bucket this status counts toward on the Calls Made funnel. */}
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        aria-label={`Funnel bucket for ${o.name}`}
        title="Calls Made funnel bucket"
        className="rounded-md border bg-background px-2 py-1.5 text-[12px] font-medium"
      >
        {OUTCOME_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
      <label className="flex items-center gap-1.5 text-[12px] font-medium">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 accent-[var(--brand)]" /> Active
      </label>
      <button
        type="button"
        disabled={!dirty || save.isPending}
        onClick={() => save.mutate()}
        className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11.5px] font-semibold text-primary-foreground disabled:opacity-40"
      >
        <Check className="h-3.5 w-3.5" /> Save
      </button>
      <button type="button" onClick={() => remove.mutate()} className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-[#9e2b21]" aria-label={`Delete ${o.name}`}>
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function OutcomeManagement() {
  const invalidate = useInvalidate();
  const { data: list = [], isLoading } = useQuery({ queryKey: ['outcomes-all'], queryFn: outcomesApi.listAll, retry: false });
  const [newName, setNewName] = useState('');

  const create = useMutation({
    mutationFn: (name: string) => outcomesApi.create({ name }),
    onSuccess: () => { invalidate(); setNewName(''); },
  });

  function add() {
    const n = newName.trim();
    if (n) create.mutate(n);
  }

  return (
    <div className="rounded-2xl border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b px-[18px] py-4">
        <ListChecks className="h-4 w-4 text-[var(--brand)]" />
        <div>
          <h3 className="font-display text-[14px] font-semibold">Call Outcomes</h3>
          <div className="text-xs text-muted-foreground">Manage dispositions, colors, and which ones schedule a callback — no code changes needed</div>
        </div>
      </div>

      <div className="px-[18px] py-2">
        {isLoading && <p className="py-4 text-sm text-muted-foreground">Loading…</p>}
        {list.map((o) => <OutcomeRow key={o.id} o={o} />)}
      </div>

      <div className="flex items-center gap-2 border-t px-[18px] py-3">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="New outcome name…"
          className="min-w-[200px] flex-1 rounded-md border bg-background px-3 py-2 text-[12.5px] outline-none"
        />
        <button type="button" onClick={add} disabled={create.isPending || !newName.trim()} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-50">
          <Plus className="h-3.5 w-3.5" /> Add outcome
        </button>
      </div>
    </div>
  );
}
