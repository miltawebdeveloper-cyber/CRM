'use client';

import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlarmClock, CalendarCheck, PhoneCall, PhoneOff, type LucideIcon } from 'lucide-react';
import { outcomesApi } from '@/lib/crm';
import { MultiSelect } from '@/components/multi-select';
import type { ContactFilter, FollowUpFilter, LeadListFilters } from '@/lib/lead-list-filters';
import type { LeadListSummary } from '@/lib/leads';

/**
 * Filter controls shared by Lead Library and Lead Management, beyond the plain
 * dropdowns in `filter-controls`.
 */

interface Chip<T extends string> {
  value: T;
  label: string;
  icon: LucideIcon;
  hint: string;
}

const FOLLOW_UP_CHIPS: Chip<Exclude<FollowUpFilter, ''>>[] = [
  { value: 'today', label: 'Follow-up today', icon: CalendarCheck, hint: "Next Follow-up falls today on the lead's own clock" },
  { value: 'overdue', label: 'Overdue follow-ups', icon: AlarmClock, hint: 'Next Follow-up passed more than an hour ago' },
];

const CONTACT_CHIPS: Chip<Exclude<ContactFilter, ''>>[] = [
  { value: 'never', label: 'Never contacted', icon: PhoneOff, hint: 'No completed call, and not yet marked contacted' },
  { value: 'contacted', label: 'Contacted', icon: PhoneCall, hint: 'A completed call, or marked contacted or beyond — what the Contacted card counts' },
];

function ChipGroup<T extends string>({
  label,
  chips,
  value,
  onChange,
  counts,
}: {
  label: string;
  chips: Chip<T>[];
  value: T | '';
  onChange: (v: T | '') => void;
  /** How many leads each chip would show; omitted while unknown. */
  counts?: Partial<Record<T, number>>;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {chips.map((c) => {
        const on = value === c.value;
        return (
          <button
            key={c.value}
            type="button"
            aria-pressed={on}
            title={c.hint}
            // A second click on the active chip turns it off — chips in a group
            // are alternatives, and "neither" has to be reachable without a
            // trip to Clear.
            onClick={() => onChange(on ? '' : c.value)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium transition-colors ${
              on ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <c.icon className="h-3.5 w-3.5" /> {c.label}
            {counts?.[c.value] !== undefined && (
              <span
                className={`ml-0.5 rounded-full px-1.5 text-[10.5px] tabular-nums ${
                  on ? 'bg-primary-foreground/20' : counts[c.value] ? 'bg-muted text-foreground' : 'bg-muted/60'
                }`}
              >
                {counts[c.value]!.toLocaleString()}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One-click filters for the questions a working day starts with — who is due a
 * call back today, who was missed, and who nobody has reached yet. Each was
 * answerable before only by sorting a date column and reading it.
 *
 * Two groups, each one-of: a lead can be both "due today" and "never
 * contacted", but not "due today" and "overdue" in the same view.
 */
export function LeadQuickFilters({
  followUp,
  contact,
  onChange,
  counts,
  leading,
  trailing,
}: {
  followUp: FollowUpFilter;
  contact: ContactFilter;
  onChange: (patch: Partial<LeadListFilters>) => void;
  /**
   * The chip numbers from `GET /leads/summary` — each counted with the other
   * filters on screen, so "Overdue (5)" is what clicking it would show.
   */
  counts?: LeadListSummary['chips'];
  /** Rendered first on the row — the saved-views menu. */
  leading?: ReactNode;
  /**
   * Rendered at the far right of the row — the page's own actions (export,
   * import, add…). They used to take a row of their own above the KPI cards,
   * mostly empty space; here they share the row the chips leave free.
   */
  trailing?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      {leading}
      <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Quick filters</span>
      <ChipGroup
        label="Follow-up"
        chips={FOLLOW_UP_CHIPS}
        value={followUp}
        onChange={(v) => onChange({ followUp: v })}
        counts={counts && { today: counts.followUpToday, overdue: counts.followUpOverdue }}
      />
      <span className="h-4 w-px bg-border" aria-hidden />
      <ChipGroup
        label="Contact"
        chips={CONTACT_CHIPS}
        value={contact}
        onChange={(v) => onChange({ contact: v })}
        counts={counts && { never: counts.neverContacted, contacted: counts.contacted }}
      />
      {trailing && <div className="ml-auto flex items-center gap-2">{trailing}</div>}
    </div>
  );
}

/**
 * Call Outcome, several at once — "No Answer, Busy and Voicemail" is one retry
 * pass, not three separate filters.
 *
 * Shows outcome NAMES and stores SLUGS: the slug is what the API matches (with
 * the legacy display name as an alias), and it survives an admin renaming the
 * outcome. Options come from the configured list (Admin → Outcomes), shared
 * with the inline outcome editor through the same query key.
 */
export function LeadOutcomeFilter({
  value,
  onChange,
  className = '',
}: {
  value: string[];
  onChange: (slugs: string[]) => void;
  className?: string;
}) {
  const { data: defs = [] } = useQuery({ queryKey: ['outcomes-config'], queryFn: outcomesApi.list });
  const { names, slugByName, nameBySlug } = useMemo(
    () => ({
      names: defs.map((o) => o.name),
      slugByName: new Map(defs.map((o) => [o.name, o.slug])),
      nameBySlug: new Map(defs.map((o) => [o.slug, o.name])),
    }),
    [defs],
  );
  return (
    <MultiSelect
      icon={PhoneCall}
      label="Call Outcomes"
      options={names}
      selected={value.map((s) => nameBySlug.get(s) ?? s)}
      onChange={(picked) => onChange(picked.map((n) => slugByName.get(n) ?? n))}
      placeholder="Search outcomes…"
      emptyText="No outcomes configured"
      className={className}
      // Sized to sit in the filter bar beside the plain dropdowns.
      triggerClassName="bg-card px-3 py-2 text-[12.5px] font-medium text-[var(--brand-ink)] dark:text-foreground"
      panelClassName="min-w-[220px]"
    />
  );
}
