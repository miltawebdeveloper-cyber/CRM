'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Plus, Check } from 'lucide-react';
import { countriesApi, timezonesApi, type Country, type TimezoneOption } from '@/lib/crm';

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['timezones-all'] });
    qc.invalidateQueries({ queryKey: ['timezones-config'] }); // every picker/filter/formatter
    // Moving a zone to another country can clear a country's default zone.
    qc.invalidateQueries({ queryKey: ['countries-all'] });
    qc.invalidateQueries({ queryKey: ['countries-config'] });
  };
}

/** Rejects a typo before it reaches the API, the same check the API runs. */
function isIanaZone(v: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

function errorText(e: unknown): string {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
  return Array.isArray(msg) ? msg.join(', ') : msg ?? 'Could not save';
}

function CountrySelect({ value, onChange, countries }: { value: string; onChange: (v: string) => void; countries: Country[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} title="Country this zone belongs to" className="rounded-md border bg-background px-2 py-1.5 text-[12px]">
      <option value="">Any country</option>
      {countries.map((c) => <option key={c.id} value={c.code}>{c.name}</option>)}
      {value && !countries.some((c) => c.code === value) && <option value={value}>{value}</option>}
    </select>
  );
}

function TimezoneRow({ z, countries }: { z: TimezoneOption; countries: Country[] }) {
  const invalidate = useInvalidate();
  const [label, setLabel] = useState(z.label);
  const [active, setActive] = useState(z.isActive);
  const [country, setCountry] = useState(z.countryCode ?? '');

  // No re-sync effect: the parent keys this row by its saved values, so a save
  // that changes them remounts it with fresh state (server is the source of truth).

  const save = useMutation({
    mutationFn: () => timezonesApi.update(z.id, { label, isActive: active, countryCode: country || null }),
    onSuccess: invalidate,
  });

  const dirty = label !== z.label || active !== z.isActive || country !== (z.countryCode ?? '');

  return (
    <div className="flex flex-wrap items-center gap-3 border-b py-2.5 last:border-0">
      <span className="w-[52px] text-[12.5px] font-semibold" title="Code stored on leads; fixed at creation">{z.code}</span>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        className={`min-w-[160px] flex-1 rounded-md border bg-background px-2.5 py-1.5 text-[12.5px] ${active ? '' : 'opacity-50 line-through'}`}
      />
      <span className="text-[11.5px] text-muted-foreground" title="IANA zone; fixed at creation">{z.ianaZone}</span>
      <CountrySelect value={country} onChange={setCountry} countries={countries} />
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

export function TimezoneManagement() {
  const invalidate = useInvalidate();
  const { data: list = [], isLoading } = useQuery({ queryKey: ['timezones-all'], queryFn: timezonesApi.listAll, retry: false });
  const { data: countries = [] } = useQuery({ queryKey: ['countries-config'], queryFn: countriesApi.list });
  const [newCountry, setNewCountry] = useState('');
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [iana, setIana] = useState('');
  const [error, setError] = useState('');

  const create = useMutation({
    mutationFn: () => timezonesApi.create({ code: code.trim().toUpperCase(), label: label.trim(), ianaZone: iana.trim(), countryCode: newCountry || null }),
    onSuccess: () => { invalidate(); setCode(''); setLabel(''); setIana(''); setNewCountry(''); setError(''); },
    onError: (e) => setError(errorText(e)),
  });

  function add() {
    if (!code.trim() || !label.trim() || !iana.trim()) return setError('Code, label and IANA zone are all required.');
    if (!isIanaZone(iana.trim())) return setError(`"${iana.trim()}" is not a recognised IANA zone (e.g. Europe/Berlin).`);
    setError('');
    create.mutate();
  }

  const input = 'rounded-md border bg-background px-3 py-2 text-[12.5px] outline-none';

  return (
    <div className="rounded-2xl border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b px-[18px] py-4">
        <Clock className="h-4 w-4 text-[var(--brand)]" />
        <div>
          <h3 className="font-display text-[14px] font-semibold">Time Zones</h3>
          <div className="text-xs text-muted-foreground">Zones offered on leads, filters and callbacks — no code changes needed</div>
        </div>
      </div>

      <div className="px-[18px] py-2">
        {isLoading && <p className="py-4 text-sm text-muted-foreground">Loading…</p>}
        {/* Keyed by the saved values too — see CountryRow. */}
        {list.map((z) => <TimezoneRow key={`${z.id}|${z.label}|${z.isActive}|${z.countryCode ?? ''}`} z={z} countries={countries} />)}
        {!isLoading && list.length === 0 && <p className="py-4 text-sm text-muted-foreground">No time zones yet.</p>}
      </div>

      <div className="space-y-2 border-t px-[18px] py-3">
        <div className="flex flex-wrap items-center gap-2" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code (e.g. CET)" maxLength={20} className={`${input} w-[110px]`} />
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. CET (Central European Time))" className={`${input} min-w-[180px] flex-1`} />
          <input value={iana} onChange={(e) => setIana(e.target.value)} placeholder="IANA zone (e.g. Europe/Berlin)" className={`${input} min-w-[170px] flex-1`} />
          <CountrySelect value={newCountry} onChange={setNewCountry} countries={countries} />
          <button type="button" onClick={add} disabled={create.isPending} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-50">
            <Plus className="h-3.5 w-3.5" /> Add zone
          </button>
        </div>
        {error && <p className="text-[12px] text-destructive">{error}</p>}
      </div>
    </div>
  );
}
