'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, X } from 'lucide-react';
import { callsApi, outcomesApi } from '@/lib/crm';
import { type Lead } from '@/lib/leads';
import { OutcomePill } from '@/components/outcome-pill';
import { invalidateCallActivity } from '@/lib/sync';

/**
 * The Call Outcome cell on Lead Management — a pill that becomes a dropdown on a
 * single click, saving as soon as an option is picked.
 *
 * Editing in place rather than behind the Edit Lead page is the point: correcting
 * a disposition is a one-field change, usually spotted while scanning the list,
 * and a full page round-trip costs far more than the mistake did.
 *
 * The options come from the configured Outcome list (Admin → Outcomes) rather
 * than a hard-coded set, so renaming or adding an outcome shows up here with no
 * code change — and a lead can never be given an outcome the rest of the CRM
 * doesn't recognise.
 *
 * Saving is not a plain field write. The outcome drives the lead's status, its
 * closure credit and its callback, so it goes through the same disposition path
 * the Calling Panel uses, and corrects the lead's most recent call too — which is
 * what keeps Calls Made, Analytics and the dashboards showing the same thing.
 */
export function LeadOutcomeCell({ lead, canEdit = true }: { lead: Lead; canEdit?: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState(lead.callStatus ?? '');
  const [when, setWhen] = useState('');

  // Cached app-wide under the same key the Calling Panel uses, so opening the
  // dropdown costs nothing after the first lead.
  const { data: outcomes = [] } = useQuery({ queryKey: ['outcomes-config'], queryFn: outcomesApi.list, enabled: editing });

  const current = lead.callStatus ?? '';
  const def = outcomes.find((o) => o.slug === current);
  const chosen = outcomes.find((o) => o.slug === choice);
  // A callback-scheduling outcome needs a date; the lead may already have one.
  const needsDate = !!chosen?.schedulesCallback && !lead.callbackAt;

  const close = () => { setEditing(false); setWhen(''); setChoice(current); };

  const save = useMutation({
    mutationFn: (slug: string) => callsApi.updateLeadOutcome(lead.id, slug, when || undefined),
    meta: { successMessage: 'Call outcome updated' },
    // One helper refreshes every module that reflects call activity — the lead
    // list, the lead's own page, the Calling Panel, Calls Made, Analytics, the
    // reports and the dashboards. See lib/sync.ts.
    onSuccess: () => { invalidateCallActivity(qc); close(); },
  });

  if (!editing) {
    const pill = current ? (
      <OutcomePill name={def?.name ?? current.replace(/_/g, ' ')} color={def?.color} />
    ) : (
      <span className="text-muted-foreground">—</span>
    );
    if (!canEdit) return pill;
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Click to change the call outcome"
        aria-label={`Change call outcome${def ? ` (currently ${def.name})` : ''}`}
        className="group inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-muted"
      >
        {pill}
        <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <select
        autoFocus
        value={choice}
        disabled={save.isPending}
        onChange={(e) => {
          const slug = e.target.value;
          setChoice(slug);
          const next = outcomes.find((o) => o.slug === slug);
          // Straight to the save unless a callback date is still owed — the API
          // refuses that combination, so the field appears rather than the save
          // failing after the fact.
          if (slug && !(next?.schedulesCallback && !lead.callbackAt)) save.mutate(slug);
        }}
        className="max-w-[180px] rounded-md border bg-background px-2 py-1 text-[12px] font-medium outline-none focus:border-primary"
      >
        <option value="">Select…</option>
        {outcomes.map((o) => (
          <option key={o.id} value={o.slug}>{o.name}</option>
        ))}
      </select>
      {needsDate && (
        <>
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            // Zones are nullable, so the label has to cope with not having one
            // rather than interpolating a literal "null" into the tooltip.
            title={
              lead.timezone
                ? `Callback time — in the lead's time zone (${lead.timezone})`
                : "Callback time — this lead has no time zone set, so saving will be refused until one is chosen"
            }
            className="rounded-md border bg-background px-2 py-1 text-[12px] outline-none focus:border-primary"
          />
          <button
            type="button"
            disabled={!when || save.isPending}
            onClick={() => save.mutate(choice)}
            className="rounded-md bg-primary px-2 py-1 text-[11.5px] font-semibold text-primary-foreground disabled:opacity-50"
          >
            Save
          </button>
        </>
      )}
      <button
        type="button"
        onClick={close}
        aria-label="Cancel"
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
    </div>
  );
}
