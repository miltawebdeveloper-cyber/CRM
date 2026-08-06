'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Filter, Loader2, Pencil, User, X } from 'lucide-react';
import { api } from '@/lib/api';
import { type Role } from '@/lib/nav';
import { callsApi, outcomesApi, type Outcome, type OutcomeRecord } from '@/lib/crm';
import { PageHead } from '@/components/page-head';
import { OutcomePill } from '@/components/outcome-pill';
import { DataTable, type ColumnDef } from '@/components/data-table';
import { DateFilter, FilterSelect, SearchInput } from '@/components/filter-controls';
import { inDateBounds, EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { formatInLeadZone } from '@/lib/timezone';
import { invalidateCallActivity } from '@/lib/sync';
import { formatDateTime } from '@/lib/display-settings';

/**
 * The Outcome column: a pill that becomes a picker on a single click.
 *
 * Editing in place rather than behind a dialog is deliberate — correcting a
 * disposition is a one-field change spotted while scanning the log, and a modal
 * for it would cost more clicks than the mistake did.
 *
 * Picking an outcome saves immediately. The one exception is an outcome that
 * schedules a callback on a lead that hasn't got one: that needs a date, and the
 * API refuses without it, so the field appears rather than letting the save fail.
 */
function OutcomeCell({ record, defs, canEdit }: { record: OutcomeRecord; defs: Outcome[]; canEdit: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState(record.outcome ?? '');
  const [when, setWhen] = useState('');

  const def = record.outcome ? defs.find((o) => o.slug === record.outcome) : undefined;
  const chosen = defs.find((o) => o.slug === choice);
  // The lead already has a callback, so re-picking a scheduling outcome keeps it.
  const hasCallback = !!record.lead?.callbackAt;
  const needsDate = !!chosen?.schedulesCallback && !hasCallback;

  const close = () => { setEditing(false); setWhen(''); setChoice(record.outcome ?? ''); };

  const save = useMutation({
    mutationFn: (slug: string) => callsApi.updateOutcome(record.id, slug, when || undefined),
    meta: { successMessage: 'Outcome updated' },
    onSuccess: () => {
      // The correction re-applies the disposition, so the lead's status, its
      // callback and every count derived from them move with it.
      invalidateCallActivity(qc);
      close();
    },
  });

  if (!editing) {
    const pill = record.outcome
      ? <OutcomePill name={def?.name ?? record.outcome.replace(/_/g, ' ')} color={def?.color} />
      : <span className="text-muted-foreground">—</span>;
    if (!canEdit) return pill;
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Click to change this outcome"
        aria-label={`Change outcome${def ? ` (currently ${def.name})` : ''}`}
        className="group inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-muted"
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
          const next = defs.find((o) => o.slug === slug);
          // Straight to the save unless a date is still owed.
          if (slug && !(next?.schedulesCallback && !hasCallback)) save.mutate(slug);
        }}
        className="rounded-md border bg-background px-2 py-1 text-[12px] font-medium outline-none focus:border-primary"
      >
        <option value="">Select…</option>
        {defs.map((o) => <option key={o.id} value={o.slug}>{o.name}</option>)}
      </select>
      {needsDate && (
        <>
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            title={`Callback time — in the lead's time zone (${record.lead?.timezone ?? 'EST'})`}
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
      <button type="button" onClick={close} aria-label="Cancel" className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-muted">
        <X className="h-3.5 w-3.5" />
      </button>
      {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
    </div>
  );
}

export default function OutcomesPage() {
  const { data: rows = [], isLoading } = useQuery({ queryKey: ['outcomes'], queryFn: () => callsApi.outcomes(), retry: false });
  const { data: outcomeDefs = [] } = useQuery({ queryKey: ['outcomes-config'], queryFn: outcomesApi.list });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });
  const role = me?.role as Role | undefined;
  const isManager = role === 'admin' || role === 'team_leader';

  const OUTCOME_OPTS = useMemo(
    () => [{ label: 'All Outcomes', value: '' }, ...outcomeDefs.map((o) => ({ label: o.name, value: o.slug }))],
    [outcomeDefs],
  );
  const [outcome, setOutcome] = useState('');
  const [userId, setUserId] = useState('');
  const [range, setRange] = useState<DateFilterValue>(EMPTY_DATE_FILTER);
  const [q, setQ] = useState('');

  // Distinct callers present in the data → User filter (req 6).
  const userOpts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) if (r.caller) seen.set(r.caller.id, r.caller.name);
    return [
      { label: 'All Users', value: '' },
      ...Array.from(seen, ([value, label]) => ({ label, value })).sort((a, b) => a.label.localeCompare(b.label)),
    ];
  }, [rows]);

  const term = q.trim().toLowerCase();
  const filtered = rows.filter((r) =>
    (!outcome || r.outcome === outcome) &&
    (!userId || r.caller?.id === userId) &&
    inDateBounds(r.createdAt, range) &&
    (!term ||
      (r.lead?.businessName ?? '').toLowerCase().includes(term) ||
      (r.lead?.phone ?? '').toLowerCase().includes(term) ||
      (r.caller?.name ?? '').toLowerCase().includes(term)),
  );

  // Who may correct a record: a rep their own calls, a manager anyone's. Mirrors
  // the API's rule so the pill isn't offered where the save would be refused.
  const canEdit = (r: OutcomeRecord) => isManager || (!!me?.id && r.caller?.id === me.id);

  const columns = useMemo<ColumnDef<OutcomeRecord>[]>(() => [
    { key: 'when', header: 'When', required: true, render: (r) => formatDateTime(r.createdAt) },
    { key: 'lead', header: 'Lead', required: true, render: (r) => r.lead?.businessName ?? '—' },
    { key: 'caller', header: 'Caller', render: (r) => r.caller?.name ?? '—' },
    { key: 'phone', header: 'Phone', render: (r) => r.lead?.phone ?? '—' },
    {
      key: 'outcome',
      header: 'Outcome',
      // One click on the pill turns it into a picker — the log is where a
      // mis-picked disposition gets noticed, so it is where it gets fixed.
      render: (r) => <OutcomeCell record={r} defs={outcomeDefs} canEdit={canEdit(r)} />,
    },
    {
      key: 'callback',
      header: 'Callback',
      // The customer's clock, with the zone named — matching every other
      // scheduled time in the CRM.
      render: (r) => r.callbackAt
        ? <span className="font-medium text-[#a8431f]">{formatInLeadZone(r.callbackAt, r.lead?.timezone)}</span>
        : '—',
    },
    {
      key: 'pin',
      header: 'Pinned',
      render: (r) => {
        const pinned = !!(r.lead?.callbackAt && !r.lead.callbackCompletedAt && new Date(r.lead.callbackAt) <= new Date());
        return pinned ? <span className="rounded-full bg-[#fde9e6] px-2 py-0.5 text-[10.5px] font-semibold text-[#a8431f]">Pinned</span> : '—';
      },
    },
    // `canEdit` closes over `me`, so the deps track the value it reads rather
    // than the function identity, which changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [outcomeDefs, isManager, me?.id]);

  return (
    <div>
      <PageHead>
        <div className="flex flex-wrap items-center gap-2.5">
          <SearchInput value={q} onChange={setQ} placeholder="Search lead, caller, phone…" className="min-w-[220px]" />
          {isManager && <FilterSelect icon={User} value={userId} onChange={setUserId} options={userOpts} />}
          <FilterSelect icon={Filter} value={outcome} onChange={setOutcome} options={OUTCOME_OPTS} />
          <DateFilter value={range} onChange={setRange} />
        </div>
      </PageHead>

      <DataTable
        tableKey="outcomes"
        columns={columns}
        rows={filtered}
        getRowKey={(r) => r.id}
        title="Outcome Records"
        subtitle={`${filtered.length} shown`}
        loading={isLoading}
        emptyText="No outcome records match the current filters."
        selectionMode="row"
      />
    </div>
  );
}
