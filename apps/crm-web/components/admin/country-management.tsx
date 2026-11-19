'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Plus, Check } from 'lucide-react';
import { countriesApi, timezonesApi, type Country, type TimezoneOption } from '@/lib/crm';

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['countries-all'] });
    qc.invalidateQueries({ queryKey: ['countries-config'] }); // create-form/filter pickers
  };
}

function CountryRow({ c, zones }: { c: Country; zones: TimezoneOption[] }) {
  const invalidate = useInvalidate();
  const [name, setName] = useState(c.name);
  const [active, setActive] = useState(c.isActive);
  const [defaultTz, setDefaultTz] = useState(c.defaultTimezone ?? '');

  // No re-sync effect: the parent keys this row by its saved values, so a save
  // that changes them remounts it with fresh state (server is the source of truth).

  const save = useMutation({
    mutationFn: () => countriesApi.update(c.id, { name, isActive: active, defaultTimezone: defaultTz || null }),
    onSuccess: invalidate,
  });

  // Only this country's own zones can be its default (set a zone's country
  // in the Time Zones card first).
  const ownZones = zones.filter((z) => z.countryCode === c.code);
  const dirty = name !== c.name || active !== c.isActive || defaultTz !== (c.defaultTimezone ?? '');

  return (
    <div className="flex flex-wrap items-center gap-3 border-b py-2.5 last:border-0">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className={`min-w-[160px] flex-1 rounded-md border bg-background px-2.5 py-1.5 text-[12.5px] ${active ? '' : 'opacity-50 line-through'}`}
      />
      <span className="text-[11.5px] text-muted-foreground" title="Exact value stored on leads; set at creation">{c.code}</span>
      <select
        value={defaultTz}
        onChange={(e) => setDefaultTz(e.target.value)}
        disabled={ownZones.length === 0}
        title={ownZones.length ? 'Time zone filled in when this country is picked' : 'No time zones belong to this country yet — link one in the Time Zones card'}
        className="rounded-md border bg-background px-2 py-1.5 text-[12px] disabled:opacity-50"
      >
        <option value="">No default zone</option>
        {ownZones.map((z) => <option key={z.id} value={z.code}>{z.code}</option>)}
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
    </div>
  );
}

export function CountryManagement() {
  const invalidate = useInvalidate();
  const { data: list = [], isLoading } = useQuery({ queryKey: ['countries-all'], queryFn: countriesApi.listAll, retry: false });
  const { data: zones = [] } = useQuery({ queryKey: ['timezones-config'], queryFn: timezonesApi.list });
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
        {/* Keyed by the saved values too: a save that changes them remounts the row
            with fresh local state, instead of an effect copying props into state. */}
        {list.map((c) => <CountryRow key={`${c.id}|${c.name}|${c.isActive}|${c.defaultTimezone ?? ''}`} c={c} zones={zones} />)}
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
