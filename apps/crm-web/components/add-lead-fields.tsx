'use client';

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { CreateLeadInput } from '@/lib/leads';
import { assignmentsApi, outcomesApi } from '@/lib/crm';

/**
 * The fields of the Lead Library's Add Lead form, in sections.
 *
 * It was one flat run of ~27 boxes in import-column order, so Phone sat between
 * Designation and Alt Phone and the required fields were scattered across the
 * grid. Grouped now by what a person is filling in — the company, who to talk
 * to, where they are, and where the lead stands — with the required ones first
 * in their section.
 *
 * Rendered inside the form's grid; each section heading spans the full row.
 * Two fields changed kind as well as place:
 *  • Assigned To is a list of employees, not free text — a misspelt name used
 *    to surface only as the server failing to resolve it. It sends the
 *    employee's email, which the API matches exactly.
 *  • The four contact dates take a time, on the lead's own clock, because the
 *    grid shows them to the minute and a booked follow-up is an hour, not a day.
 */
export function AddLeadFields({
  form,
  onChange,
  onCountry,
  countries,
  zones,
}: {
  form: CreateLeadInput;
  onChange: (patch: Partial<CreateLeadInput>) => void;
  /** Picking a country can also change the zone — the page owns that rule. */
  onCountry: (code: string) => void;
  countries: { id: string; code: string; name: string }[];
  zones: { value: string; label: string }[];
}) {
  const { data: summary } = useQuery({ queryKey: ['assignments-summary'], queryFn: assignmentsApi.summary });
  const { data: outcomes = [] } = useQuery({ queryKey: ['outcomes-config'], queryFn: outcomesApi.list });
  const callers = summary?.callers ?? [];

  const text = (key: keyof CreateLeadInput, label: string, opts: { required?: boolean; autoFocus?: boolean; wide?: boolean; type?: string } = {}) => (
    <Field key={key} label={label} required={opts.required} wide={opts.wide}>
      <input
        type={opts.type ?? 'text'}
        value={(form[key] as string | undefined) ?? ''}
        onChange={(e) => onChange({ [key]: e.target.value } as Partial<CreateLeadInput>)}
        required={opts.required}
        autoFocus={opts.autoFocus}
        className={INPUT}
      />
    </Field>
  );
  const when = (key: 'firstContact' | 'lastContact' | 'nextFollowUpDate' | 'meetingDate', label: string) => (
    <Field key={key} label={label}>
      <input
        type="datetime-local"
        value={form[key] ?? ''}
        onChange={(e) => onChange({ [key]: e.target.value })}
        className={INPUT}
      />
    </Field>
  );

  return (
    <>
      <Section title="Company" first />
      {text('businessName', 'Company Name', { required: true, autoFocus: true })}
      {text('industry', 'Industry')}
      {text('companySize', 'Company Size')}
      {text('foundedYear', 'Founded Year')}
      {text('website', 'Website')}
      {text('socialMedia', 'Social Media')}

      <Section title="Contact" />
      {text('phone', 'Phone', { required: true, type: 'tel' })}
      {text('altPhone', 'Alt Phone', { type: 'tel' })}
      {text('email', 'Email', { type: 'email' })}
      {text('contactName', 'Contact Person (Primary)')}
      {text('contactName2', 'Designation')}

      <Section title="Location" />
      {text('state', 'State', { required: true })}
      {text('city', 'City', { required: true })}
      <Field label="Country">
        <select value={form.country ?? ''} onChange={(e) => onCountry(e.target.value)} className={INPUT}>
          <option value="">— none —</option>
          {countries.map((c) => <option key={c.id} value={c.code}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Time Zone" hint="Callbacks are booked on this clock. Picking a country fills it in.">
        <select value={form.timezone ?? ''} onChange={(e) => onChange({ timezone: e.target.value })} className={INPUT}>
          <option value="">— not set —</option>
          {zones.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </Field>
      {text('address', 'Address', { wide: true })}

      <Section title="Pipeline" note={`Dates and times are the lead's local time${form.timezone ? ` (${form.timezone})` : ''}.`} />
      <Field label="Assigned To">
        <select value={form.caller ?? ''} onChange={(e) => onChange({ caller: e.target.value })} className={INPUT}>
          <option value="">— Unassigned —</option>
          {callers.map((c) => (
            <option key={c.id} value={c.email}>
              {c.name} · {c.leadCount.toLocaleString()} lead{c.leadCount === 1 ? '' : 's'}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Call Outcome">
        <select value={form.callStatus ?? ''} onChange={(e) => onChange({ callStatus: e.target.value })} className={INPUT}>
          <option value="">— none —</option>
          {outcomes.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
        </select>
      </Field>
      {text('leadSource', 'Lead Source')}
      {text('leadId', 'Lead ID')}
      {text('leadGenerationId', 'Lead Generation ID')}
      {text('lostReason', 'Lost Reason')}
      {when('firstContact', 'First Contact')}
      {when('lastContact', 'Last Contact')}
      {when('nextFollowUpDate', 'Next Follow-up')}
      {when('meetingDate', 'Meeting')}
      <Field label="Follow-up Count">
        <input
          type="number"
          min={0}
          value={form.followupCount ?? ''}
          onChange={(e) => onChange({ followupCount: e.target.value ? parseInt(e.target.value, 10) : undefined })}
          className={INPUT}
        />
      </Field>
      <label className="col-span-full space-y-1 text-sm">
        <span className="font-medium">Comments</span>
        <textarea value={form.comments ?? ''} onChange={(e) => onChange({ comments: e.target.value })} rows={2} className={INPUT} />
      </label>
    </>
  );
}

const INPUT = 'w-full rounded-md border bg-background px-3 py-2';

function Section({ title, note, first }: { title: string; note?: string; first?: boolean }) {
  return (
    <div className={`col-span-full flex flex-wrap items-baseline justify-between gap-x-3 border-b pb-1 ${first ? '' : 'mt-3'}`}>
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {note && <span className="text-[11px] text-muted-foreground">{note}</span>}
    </div>
  );
}

function Field({ label, required, wide, hint, children }: { label: string; required?: boolean; wide?: boolean; hint?: string; children: ReactNode }) {
  return (
    <label className={`space-y-1 text-sm ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="font-medium">
        {label}
        {required && <span className="text-[var(--tone-red-fg)]"> *</span>}
      </span>
      {children}
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}
