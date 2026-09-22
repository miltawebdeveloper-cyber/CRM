'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Plus, Check } from 'lucide-react';
import { countriesApi, type Country } from '@/lib/crm';

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['countries-all'] });
    qc.invalidateQueries({ queryKey: ['countries-config'] }); // create-form/filter pickers
  };
}

function CountryRow({ c }: { c: Country }) {
  const invalidate = useInvalidate();
  const [name, setName] = useState(c.name);
  const [active, setActive] = useState(c.isActive);

  // Re-sync local state after a save (server is the source of truth).
  useEffect(() => { setName(c.name); setActive(c.isActive); }, [c.name, c.isActive]);

  const save = useMutation({
    mutationFn: () => countriesApi.update(c.id, { name, isActive: active }),
    onSuccess: invalidate,
  });

  const dirty = name !== c.name || active !== c.isActive;

  return (
    <div className="flex flex-wrap items-center gap-3 border-b py-2.5 last:border-0">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className={`min-w-[160px] flex-1 rounded-md border bg-background px-2.5 py-1.5 text-[12.5px] ${active ? '' : 'opacity-50 line-through'}`}
      />
      <span className="text-[11.5px] text-muted-foreground" title="Exact value stored on leads; set at creation">{c.code}</span>
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
    </div>
  );
}

export function CountryManagement() {
  const invalidate = useInvalidate();
  const { data: list = [], isLoading } = useQuery({ queryKey: ['countries-all'], queryFn: countriesApi.listAll, retry: false });
  const [newName, setNewName] = useState('');

  const create = useMutation({
    mutationFn: (name: string) => countriesApi.create({ name }),
    onSuccess: () => { invalidate(); setNewName(''); },
  });

  function add() {
    const n = newName.trim();
    if (n) create.mutate(n);
  }

  return (
    <div className="rounded-2xl border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b px-[18px] py-4">
        <Globe className="h-4 w-4 text-[var(--brand)]" />
        <div>
          <h3 className="font-display text-[14px] font-semibold">Countries</h3>
          <div className="text-xs text-muted-foreground">Countries offered on the lead create form and filters — no code changes needed</div>
        </div>
      </div>

      <div className="px-[18px] py-2">
        {isLoading && <p className="py-4 text-sm text-muted-foreground">Loading…</p>}
        {list.map((c) => <CountryRow key={c.id} c={c} />)}
        {!isLoading && list.length === 0 && <p className="py-4 text-sm text-muted-foreground">No countries yet.</p>}
      </div>

      <div className="flex items-center gap-2 border-t px-[18px] py-3">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="New country name…"
          className="min-w-[200px] flex-1 rounded-md border bg-background px-3 py-2 text-[12.5px] outline-none"
        />
        <button type="button" onClick={add} disabled={create.isPending || !newName.trim()} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-50">
          <Plus className="h-3.5 w-3.5" /> Add country
        </button>
      </div>
    </div>
  );
}
