'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CalendarClock, CheckSquare, ChevronDown, ExternalLink, Hourglass, Info, Search, UserRoundCog, Users, X } from 'lucide-react';
import { assignmentsApi, outcomesApi, type PendingCall, type PendingMode } from '@/lib/crm';
import { Avatar } from '@/components/page-head';
import { Segmented } from '@/components/segmented';
import { IconAction } from '@/components/icon-action';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { getUserTimezone } from '@/lib/display-settings';
import { zoneParts } from '@/lib/calendar-grid';
import {
  ageTone, dayLabel, daysBetween, groupPending, matchesKind, matchesSearch, nextWeekday, OLD_AFTER_DAYS,
  quickDays, summarizeByOwner, waitingLabel, type AgeTone, type PendingKind,
} from '@/lib/pending-calls';
import { toast } from '@/lib/toast';
import { invalidateLeadBook } from '@/lib/sync';

const MODE_OPTIONS = [
  { label: 'Manual', value: 'manual' as PendingMode },
  { label: 'Automatic', value: 'automatic' as PendingMode },
];
const MODE_TEXT: Record<PendingMode, string> = {
  manual: 'Unfinished calls wait here, on their original date, for a manager to reassign.',
  automatic: 'Unfinished calls move to the next working day with the same employee.',
};

/** Age reads in words as well as colour: neutral, then amber, then red. */
const AGE_CHIP: Record<AgeTone, string> = {
  fresh: 'bg-muted text-muted-foreground',
  aging: 'bg-[var(--tone-amber-bg)] text-[var(--tone-amber-fg)]',
  old: 'bg-[var(--tone-red-bg)] text-[var(--tone-red-fg-2)]',
};

/** The columns on wide screens — shared by the column heads and every row so they line up. */
const ROW_GRID = 'md:grid-cols-[16px_96px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,190px)_108px]';

/** Rows shown per employee before "Show more" — a long backlog stays scannable. */
const ROWS_PER_GROUP = 25;

/** A user name can carry a code ("John - MAS21073"); avatars and short labels use the person's name. */
const firstName = (name: string) => name.split(' - ')[0];
const initial = (name: string) => firstName(name).trim().charAt(0).toUpperCase() || '?';
/** "Oct 13" — a day, read as UTC so no zone shifts it. */
const shortDay = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * Pending Calls — the Calling Panel tab where admins and team leaders deal
 * with assigned calls whose day passed without the customer being reached.
 *
 * Built around the job: see who is behind (a card per employee), find the
 * calls that matter (search, "not tried", "waiting 3+ days"), and move them in
 * one click — to the next working day with the same employee, or to someone
 * else on a day you pick. The Manual / Automatic setting is a small switch
 * at the top: it's chosen once, not worked every day.
 *
 * "Finished" is the customer reached (an outcome in a reached group) or the
 * lead closed; No Answer, Voice Mail and the other cold outcomes leave a call
 * unfinished, because it is still owed. Callbacks and Zoom meetings are times
 * agreed with the customer and keep their own rescheduling, so they aren't here.
 *
 * Managers only: the panel shows the tab to admins and team leaders, and the
 * API refuses anyone else.
 */
export function PendingCalls() {
  const qc = useQueryClient();
  const tz = getUserTimezone();
  const [now] = useState(() => Date.now());
  const today = zoneParts(new Date(now).toISOString(), tz).ymd;
  const next = nextWeekday(today);

  const [owner, setOwner] = useState('');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<PendingKind>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [dialogFor, setDialogFor] = useState<PendingCall[] | null>(null);
  const [switchTo, setSwitchTo] = useState<PendingMode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const { data, isLoading, isError } = useQuery({ queryKey: ['pending-calls'], queryFn: () => assignmentsApi.pending() });
  const { data: summary } = useQuery({ queryKey: ['assignments-summary'], queryFn: assignmentsApi.summary });
  const { data: outcomes = [] } = useQuery({ queryKey: ['outcomes-config'], queryFn: outcomesApi.list });
  const outcomeName = useMemo(() => new Map(outcomes.map((o) => [o.slug, o.name])), [outcomes]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const mode = data?.mode;
  const owners = useMemo(() => summarizeByOwner(items), [items]);
  // The employee filter decides the counts on the quick filters; search and the filter decide the list.
  // Plain derived values: a few thousand rows filter in no time, and the compiler memoizes as it sees fit.
  const ofOwner = owner ? items.filter((i) => i.owner.id === owner) : items;
  const visible = ofOwner.filter((i) => matchesKind(i, kind, today) && matchesSearch(i, q));
  const groups = groupPending(visible);
  const kindCount = (k: PendingKind) => ofOwner.filter((i) => matchesKind(i, k, today)).length;

  // Bulk actions act on what's ticked AND on screen — never on calls a filter has hidden.
  const visibleIds = new Set(visible.map((i) => i.id));
  const selected = new Set([...picked].filter((id) => visibleIds.has(id)));
  const toggle = (ids: string[], on: boolean) => {
    const n = new Set(picked);
    for (const id of ids) if (on) n.add(id); else n.delete(id);
    setPicked(n);
  };

  // People to give calls to: the team list, with each one's pending count beside them.
  const people = useMemo(() => {
    const pending = new Map(owners.map((o) => [o.owner.id, o.count]));
    return (summary?.callers ?? []).map((c) => ({ id: c.id, name: c.name, pending: pending.get(c.id) ?? 0 }));
  }, [summary, owners]);

  // A moved call changes whose queue it is in and on which day — every view of
  // the book, the Calling Panel's cards included (see lib/sync.ts).
  const refresh = () => invalidateLeadBook(qc);

  /** One move, whoever asked for it: a row, a group, the selection or the dialog. */
  const move = useMutation({
    mutationFn: (v: { calls: PendingCall[]; day: string; callerId?: string }) =>
      assignmentsApi.reschedule({ leadIds: v.calls.map((c) => c.id), day: v.day, callerId: v.callerId }),
    onSuccess: (r, v) => {
      const who = v.callerId ? firstName(people.find((p) => p.id === v.callerId)?.name ?? 'them') : null;
      const what = v.calls.length === 1 ? v.calls[0].businessName : `${r.assigned} call${r.assigned === 1 ? '' : 's'}`;
      toast.success(`Moved ${what} to ${dayLabel(v.day)}${who ? `, now with ${who}` : ''}`);
      if (r.skipped.length) toast.info(`${r.skipped.length} couldn’t move — ${dayLabel(v.day)} has already passed in their time zone.`);
      setPicked((p) => new Set([...p].filter((id) => !v.calls.some((c) => c.id === id))));
      setDialogFor(null);
      refresh();
    },
  });
  const moving = (id: string) => move.isPending && !!move.variables?.calls.some((c) => c.id === id);

  const setMode = useMutation({
    mutationFn: (m: PendingMode) => assignmentsApi.setPendingMode(m),
    onSuccess: (r) => {
      toast.success(r.mode === 'manual' ? 'Pending calls: Manual assignment' : 'Pending calls: Automatic assignment');
      void qc.invalidateQueries({ queryKey: ['pending-calls'] });
    },
  });

  const selectedCalls = visible.filter((i) => selected.has(i.id));
  const untried = items.filter((i) => i.attempts === 0).length;
  const oldestDay = owners.reduce<string | null>((min, o) => (!min || o.oldest < min ? o.oldest : min), null);
  const kindOptions = (
    [
      ['all', 'All'],
      ['untried', 'Not tried'],
      ['tried', 'Tried'],
      ['old', `${OLD_AFTER_DAYS}+ days`],
    ] as const
  ).map(([value, label]) => ({ value: value as PendingKind, label: `${label} · ${kindCount(value)}` }));
  const filtered = !!q.trim() || kind !== 'all' || !!owner;

  return (
    <div className="space-y-3">
      {/* One compact header: what this is, the live count, the setting, and the filters.
          No overflow clipping: the info tooltip has to be able to hang below the card. */}
      <section aria-label="Pending calls" className="rounded-2xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3">
          <div className="flex min-w-0 flex-1 basis-[240px] items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--tone-amber-bg)] text-[var(--tone-amber-fg)]"><Hourglass className="h-4 w-4" aria-hidden /></span>
            <div className="min-w-0">
              <h2 className="font-display text-[15px] font-semibold leading-tight">Pending calls</h2>
              <p className="truncate text-[11.5px] text-muted-foreground">
                {isLoading
                  ? 'Loading…'
                  : items.length
                    ? `${items.length} waiting · oldest ${daysBetween(oldestDay!, today)} day${daysBetween(oldestDay!, today) === 1 ? '' : 's'} · ${untried} not tried yet`
                    : 'Nothing waiting'}
              </p>
            </div>
          </div>
          {/* The one setting — small, because it's chosen once, not worked every day. */}
          <div className="flex items-center gap-2">
            <span id="pending-mode-label" className="hidden text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground sm:inline">If unfinished</span>
            {mode ? (
              <Segmented options={MODE_OPTIONS} value={mode} onChange={(m) => m !== mode && setSwitchTo(m)} />
            ) : (
              <div className="h-8 w-40 animate-pulse rounded-md bg-muted" aria-hidden />
            )}
            <InfoTip mode={mode} />
          </div>
        </div>

        {items.length > 0 && (
          <div className="space-y-2.5 rounded-b-2xl border-t bg-muted/25 px-4 py-2.5">
            {/* Who is behind: a pill per employee — the count, and how old their oldest call is. */}
            <div className="flex flex-wrap items-center gap-2">
              <div role="group" aria-label="Employees" className="-my-0.5 flex min-w-0 flex-1 basis-[320px] gap-1.5 overflow-x-auto py-0.5">
                <OwnerPill active={!owner} onClick={() => setOwner('')} icon={<Users className="h-3.5 w-3.5" aria-hidden />} name="All" title="All employees" count={items.length} />
                {owners.map((o) => {
                  const age = daysBetween(o.oldest, today);
                  return (
                    <OwnerPill
                      key={o.owner.id}
                      active={owner === o.owner.id}
                      onClick={() => setOwner(owner === o.owner.id ? '' : o.owner.id)}
                      icon={<span className="text-[10px] font-bold">{initial(o.owner.name)}</span>}
                      name={firstName(o.owner.name)}
                      title={`${o.owner.name}: ${o.count} pending, oldest ${waitingLabel(age)}`}
                      count={o.count}
                      age={age}
                    />
                  );
                })}
              </div>
              <label className="relative w-full sm:w-[250px]">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search company, phone, lead ID…"
                  aria-label="Search pending calls"
                  className="h-8 w-full rounded-md border bg-card pl-8 pr-7 text-[12px]"
                />
                {q && (
                  <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-muted">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <KindTabs options={kindOptions} value={kind} onChange={setKind} />
              {mode === 'automatic' && (
                <span className="text-[11px] text-muted-foreground sm:ml-auto">Automatic is on — these move to the next working day on their own.</span>
              )}
            </div>
          </div>
        )}
      </section>

      {/* The selection's actions — at the top of the list, where the eye already is. */}
      {selectedCalls.length > 0 && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-primary/40 bg-card px-3 py-2 shadow-md">
          <CheckSquare className="h-4 w-4 text-primary" aria-hidden />
          <span className="text-[12.5px] font-semibold tabular-nums">{selectedCalls.length} selected</span>
          <span className="mx-1 hidden h-4 w-px bg-border sm:block" aria-hidden />
          <button
            type="button"
            disabled={move.isPending}
            onClick={() => move.mutate({ calls: selectedCalls, day: next })}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <ArrowRight className="h-3.5 w-3.5" aria-hidden /> Move to {dayLabel(next)}
          </button>
          <button type="button" onClick={() => setDialogFor(selectedCalls)} className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12px] font-semibold hover:bg-muted">
            <UserRoundCog className="h-3.5 w-3.5" aria-hidden /> Choose day or employee…
          </button>
          <button type="button" onClick={() => setPicked(new Set())} className="ml-auto text-[12px] font-semibold text-muted-foreground hover:text-foreground">Clear</button>
        </div>
      )}

      {isError ? (
        <p className="rounded-2xl border bg-card px-6 py-10 text-center text-[13px] text-muted-foreground">Couldn’t load pending calls. Try again in a moment.</p>
      ) : isLoading ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading pending calls">
          {[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-2xl border bg-card" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border bg-card px-6 py-14 text-center shadow-sm">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-[var(--brand-surface)] text-[var(--brand-on-surface)]"><CheckSquare className="h-5 w-5" aria-hidden /></span>
          <p className="mt-3 text-[14px] font-semibold">Nothing pending</p>
          <p className="mx-auto mt-1 max-w-md text-[12.5px] text-muted-foreground">
            {mode === 'manual'
              ? 'Every assigned call so far was finished on its day. Any that aren’t will wait here for you.'
              : 'Unfinished calls move to the next working day on their own, so this list only fills while they wait for that day — over a weekend, say.'}
          </p>
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-2xl border bg-card px-6 py-10 text-center">
          <p className="text-[13px] font-semibold">No pending calls match</p>
          <button type="button" onClick={() => { setQ(''); setKind('all'); setOwner(''); }} className="mt-2 text-[12.5px] font-semibold text-primary hover:underline">Clear search and filters</button>
        </div>
      ) : (
        groups.map((g) => {
          const ids = g.days.flatMap((d) => d.items.map((i) => i.id));
          const all = g.days.flatMap((d) => d.items);
          const showAll = expanded.has(g.owner.id);
          const isOpen = !collapsed.has(g.owner.id);
          // Oldest assignment day first (groupPending orders the days), the file's order within a day.
          const rows = showAll ? all : all.slice(0, ROWS_PER_GROUP);
          const oldestAge = daysBetween(g.days[0].day, today);
          const untriedHere = all.filter((i) => i.attempts === 0).length;
          const bodyId = `pending-${g.owner.id}`;
          return (
            <section key={g.owner.id} aria-label={`${g.owner.name}: ${g.total} pending`} className="overflow-hidden rounded-2xl border bg-card shadow-sm">
              <header className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 ${isOpen ? 'border-b' : ''}`}>
                <GroupCheck ids={ids} selected={selected} onToggle={toggle} label={`Select all of ${g.owner.name}’s pending calls`} />
                <Avatar name={firstName(g.owner.name)} size="md" />
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-display text-[14px] font-semibold leading-tight">{g.owner.name}</h3>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted-foreground">
                    <span><b className="font-semibold text-foreground tabular-nums">{g.total}</b> pending</span>
                    <span aria-hidden>·</span>
                    <span className={`rounded-full px-1.5 py-[1px] text-[10.5px] font-semibold tabular-nums ${AGE_CHIP[ageTone(oldestAge)]}`}>oldest {oldestAge}d</span>
                    {untriedHere > 0 && (
                      <>
                        <span aria-hidden>·</span>
                        <span><b className="font-semibold text-foreground tabular-nums">{untriedHere}</b> not tried</span>
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={move.isPending}
                    onClick={() => move.mutate({ calls: all, day: next })}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[11.5px] font-semibold hover:bg-muted disabled:opacity-50"
                    title={`Move all ${g.total} to ${dayLabel(next)}, still with ${firstName(g.owner.name)}`}
                  >
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden /> All to {dayLabel(next)}
                  </button>
                  <button type="button" onClick={() => setDialogFor(all)} className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[11.5px] font-semibold hover:bg-muted">
                    <UserRoundCog className="h-3.5 w-3.5" aria-hidden /> Reassign…
                  </button>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={bodyId}
                    aria-label={isOpen ? `Collapse ${g.owner.name}` : `Expand ${g.owner.name}`}
                    onClick={() => {
                      const n = new Set(collapsed);
                      if (isOpen) n.add(g.owner.id); else n.delete(g.owner.id);
                      setCollapsed(n);
                    }}
                    className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? '' : '-rotate-90'}`} aria-hidden />
                  </button>
                </div>
              </header>
              {isOpen && (
                <div id={bodyId}>
                  {/* Column heads — wide screens only; a phone reads each row as a card. */}
                  <div className={`hidden border-b bg-muted/40 px-4 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground md:grid md:gap-x-4 ${ROW_GRID}`} aria-hidden>
                    <span />
                    <span>Assigned</span>
                    <span>Lead</span>
                    <span>Contact</span>
                    <span>Attempts</span>
                    <span className="text-right">Actions</span>
                  </div>
                  <ul className="divide-y">
                    {rows.map((it) => (
                      <PendingRow
                        key={it.id}
                        it={it}
                        today={today}
                        next={next}
                        checked={selected.has(it.id)}
                        busy={moving(it.id)}
                        disabled={move.isPending}
                        outcomeName={outcomeName}
                        onToggle={(on) => toggle([it.id], on)}
                        onMove={() => move.mutate({ calls: [it], day: next })}
                        onReassign={() => setDialogFor([it])}
                      />
                    ))}
                  </ul>
                  {!showAll && g.total > ROWS_PER_GROUP && (
                    <button type="button" onClick={() => setExpanded(new Set([...expanded, g.owner.id]))} className="flex w-full items-center justify-center gap-1.5 border-t bg-muted/20 px-4 py-2.5 text-[12px] font-semibold text-primary hover:bg-muted/50">
                      Show {g.total - ROWS_PER_GROUP} more of {firstName(g.owner.name)}’s calls <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  )}
                </div>
              )}
            </section>
          );
        })
      )}

      {filtered && groups.length > 0 && (
        <p className="text-center text-[11.5px] text-muted-foreground">
          Showing {visible.length} of {items.length} pending call{items.length === 1 ? '' : 's'}.{' '}
          <button type="button" onClick={() => { setQ(''); setKind('all'); setOwner(''); }} className="font-semibold text-primary hover:underline">Show all</button>
        </p>
      )}
      {data?.truncated && (
        <p className="rounded-xl bg-[var(--tone-amber-bg)] px-3 py-2 text-[12px] text-[var(--tone-amber-fg)]">
          This is the first part of a very large list. Reschedule some of these and the rest will appear.
        </p>
      )}

      {dialogFor && (
        <RescheduleDialog
          calls={dialogFor}
          people={people}
          today={today}
          busy={move.isPending}
          onClose={() => setDialogFor(null)}
          onSave={(day, callerId) => move.mutate({ calls: dialogFor, day, callerId })}
        />
      )}

      {switchTo && (
        <ConfirmDialog
          title={switchTo === 'manual' ? 'Switch to Manual assignment?' : 'Switch to Automatic assignment?'}
          message={
            switchTo === 'manual'
              ? 'From the end of today, calls nobody finished keep their date and wait here for a manager. Reps’ queues will hold only the calls given for that day, plus callbacks and meetings.'
              : `Calls nobody finished move to the next working day with the same employee${items.length ? ` — including the ${items.length} waiting here now, within the hour` : ''}.`
          }
          confirmLabel={switchTo === 'manual' ? 'Switch to Manual' : 'Switch to Automatic'}
          destructive={false}
          onConfirm={() => setMode.mutateAsync(switchTo).then(() => undefined)}
          onClose={() => setSwitchTo(null)}
        />
      )}
    </div>
  );
}

/** One employee as a slim pill: initial, name, count — and the age of their oldest call, coloured. */
function OwnerPill({ active, onClick, icon, name, title, count, age }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; name: string; title: string; count: number; age?: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={title}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border pl-1 pr-2.5 text-[12px] font-semibold transition-colors ${active ? 'border-primary bg-[var(--brand-surface)] text-[var(--brand-on-surface)]' : 'bg-card hover:bg-muted'}`}
    >
      <span className={`grid h-6 w-6 place-items-center rounded-full ${active ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>{icon}</span>
      <span className="max-w-[120px] truncate">{name}</span>
      <span className="tabular-nums opacity-70">{count}</span>
      {age !== undefined && (
        <span className={`rounded-full px-1.5 py-[1px] text-[10px] font-semibold tabular-nums ${AGE_CHIP[ageTone(age)]}`} aria-label={`oldest ${waitingLabel(age)}`}>
          {age}d
        </span>
      )}
    </button>
  );
}

/**
 * The quick filters, in the look of the shared Segmented control — but each
 * label stays on one line, and on a narrow screen the row scrolls sideways
 * instead of breaking "All · 194" in two.
 */
function KindTabs({ options, value, onChange }: { options: { label: string; value: PendingKind }[]; value: PendingKind; onChange: (v: PendingKind) => void }) {
  return (
    <div role="group" aria-label="Show" className="max-w-full overflow-x-auto">
      <div className="inline-flex rounded-md border bg-muted/60 p-[3px]">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={`whitespace-nowrap rounded-[7px] px-3 py-1 text-[12px] font-semibold transition-colors ${value === o.value ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** What pending means and what each setting does — on hover or focus, out of the way otherwise. */
function InfoTip({ mode }: { mode?: PendingMode }) {
  return (
    <span className="group/info relative inline-flex">
      <button type="button" aria-label="About pending calls" className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
        <Info className="h-4 w-4" aria-hidden />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-50 mt-1.5 hidden w-[300px] rounded-lg border bg-card p-3 text-[11.5px] leading-snug text-foreground shadow-lg group-focus-within/info:block group-hover/info:block"
      >
        <span className="block font-semibold">Pending calls</span>
        <span className="mt-0.5 block text-muted-foreground">Assigned calls whose day passed without reaching the customer — No Answer and Voice Mail included.</span>
        <span className="mt-2 block"><b className={mode === 'manual' ? 'text-primary' : ''}>Manual</b> <span className="text-muted-foreground">— {MODE_TEXT.manual}</span></span>
        <span className="mt-1 block"><b className={mode === 'automatic' ? 'text-primary' : ''}>Automatic</b> <span className="text-muted-foreground">— {MODE_TEXT.automatic}</span></span>
      </span>
    </span>
  );
}

/** A checkbox for a set of calls: checked when all are, mixed when some are. */
function GroupCheck({ ids, selected, onToggle, label }: { ids: string[]; selected: Set<string>; onToggle: (ids: string[], on: boolean) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const count = ids.filter((id) => selected.has(id)).length;
  const all = count === ids.length && ids.length > 0;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = count > 0 && !all;
  }, [count, all]);
  return <input ref={ref} type="checkbox" checked={all} onChange={(e) => onToggle(ids, e.target.checked)} aria-label={label} className="h-4 w-4 shrink-0 accent-[hsl(var(--primary))]" />;
}

function PendingRow({ it, today, next, checked, busy, disabled, outcomeName, onToggle, onMove, onReassign }: {
  it: PendingCall; today: string; next: string; checked: boolean; busy: boolean; disabled: boolean; outcomeName: Map<string, string>;
  onToggle: (on: boolean) => void; onMove: () => void; onReassign: () => void;
}) {
  const tried = it.attempts > 0;
  const day = it.assignedOn ?? it.scheduledFor;
  const age = daysBetween(day, today);
  const last = it.lastOutcome ? outcomeName.get(it.lastOutcome) ?? it.lastOutcome : null;
  const attempts = tried ? (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 rounded-full bg-[var(--tone-amber-bg)] px-2 py-[1px] text-[10.5px] font-semibold tabular-nums text-[var(--tone-amber-fg)]">
        {it.attempts} attempt{it.attempts === 1 ? '' : 's'}
      </span>
      {last && <span className="truncate text-[11px] text-muted-foreground">{last}</span>}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full border border-muted-foreground/60" aria-hidden /> Not tried yet
    </span>
  );
  return (
    <li
      className={`group/row grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 transition-colors md:gap-x-4 ${ROW_GRID} ${checked ? 'bg-[var(--brand-surface)]/50' : 'hover:bg-muted/40'}`}
    >
      <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} aria-label={`Select ${it.businessName}`} className="h-4 w-4 accent-[hsl(var(--primary))]" />

      {/* Assigned: the day, and how long it has waited — the words on hover. */}
      <div className="hidden items-center gap-1.5 md:flex" title={`Assigned ${dayLabel(day)} — ${waitingLabel(age)}`}>
        <span className="text-[12px] font-semibold tabular-nums">{shortDay(day)}</span>
        <span className={`rounded-full px-1.5 py-[1px] text-[10px] font-semibold tabular-nums ${AGE_CHIP[ageTone(age)]}`}>{age}d</span>
      </div>

      {/* Lead */}
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-semibold">{it.businessName}</div>
        <div className="hidden min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground md:flex">
          <span className="truncate tabular-nums">{it.leadId}</span>
          {it.timezone && <span className="shrink-0 rounded bg-muted px-1 text-[10px] font-semibold">{it.timezone}</span>}
        </div>
        {/* On a phone: who to call first, the lead ID last — if the line runs out, it's the ID that's cut. */}
        <div className="truncate text-[11px] text-muted-foreground md:hidden">{[it.contactName, it.phone, it.leadId].filter(Boolean).join(' · ')}</div>
        {/* On a phone: the day and the attempts, under the lead. */}
        <div className="mt-1 flex min-w-0 items-center gap-1.5 md:hidden">
          <span className={`shrink-0 rounded-full px-1.5 py-[1px] text-[10px] font-semibold tabular-nums ${AGE_CHIP[ageTone(age)]}`} title={waitingLabel(age)}>
            {shortDay(day)} · {age}d
          </span>
          {attempts}
        </div>
      </div>

      {/* Contact */}
      <div className="hidden min-w-0 md:block">
        <div className="truncate text-[12px]">{it.contactName ?? <span className="text-muted-foreground">—</span>}</div>
        <div className="truncate text-[11px] tabular-nums text-muted-foreground">{it.phone ?? ''}</div>
      </div>

      {/* Attempts */}
      <div className="hidden min-w-0 md:block">{attempts}</div>

      {/* Actions — quiet until the row is hovered, but always there to tap or tab to. */}
      <div className="flex shrink-0 items-center justify-end gap-0.5">
        <IconAction variant="ghost" icon={busy ? CalendarClock : ArrowRight} busy={busy} label={`Move to ${dayLabel(next)} (same employee)`} onClick={onMove} disabled={disabled} align="end" />
        <IconAction variant="ghost" icon={UserRoundCog} label="Choose day or employee…" onClick={onReassign} align="end" />
        <IconAction variant="ghost" icon={ExternalLink} label="Open lead" href={`/leads/${it.id}`} align="end" />
      </div>
    </li>
  );
}

/** Give calls to an employee — the same one or another — for a day. */
function RescheduleDialog({ calls, people, today, busy, onClose, onSave }: {
  calls: PendingCall[]; people: { id: string; name: string; pending: number }[]; today: string; busy: boolean;
  onClose: () => void; onSave: (day: string, callerId?: string) => void;
}) {
  const quick = quickDays(today);
  const [day, setDay] = useState(quick[0].day);
  const [custom, setCustom] = useState(false);
  const [keep, setKeep] = useState(true);
  const [who, setWho] = useState('');
  const ownerIds = [...new Set(calls.map((c) => c.owner.id))];
  const oneOwner = ownerIds.length === 1 ? calls[0].owner : null;
  const weekend = [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());
  const target = keep ? null : people.find((p) => p.id === who) ?? null;
  const ready = !!day && day >= today && (keep || !!target);
  const n = calls.length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const chip = (on: boolean) =>
    `rounded-lg border px-3 py-2 text-left text-[12px] transition-colors ${on ? 'border-primary bg-[var(--brand-surface)] text-[var(--brand-on-surface)] shadow-[inset_0_0_0_1px_hsl(var(--primary))]' : 'bg-card hover:bg-muted'}`;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <button type="button" aria-label="Close" onClick={() => !busy && onClose()} className="absolute inset-0 bg-black/30" />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="reschedule-title"
        onSubmit={(e) => { e.preventDefault(); if (ready) onSave(day, keep ? undefined : who); }}
        className="relative max-h-[calc(100vh-2rem)] w-full max-w-[460px] overflow-y-auto rounded-2xl border bg-card p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="reschedule-title" className="font-display text-[15px] font-semibold">Reschedule {n === 1 ? calls[0].businessName : `${n} calls`}</h2>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">The day they were first assigned stays in each lead’s history.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
        </div>

        <fieldset className="mt-4">
          <legend className="mb-1.5 text-[11.5px] font-semibold">When</legend>
          <div className="grid grid-cols-2 gap-2">
            {quick.map((qd) => (
              <button key={qd.day} type="button" aria-pressed={!custom && day === qd.day} onClick={() => { setCustom(false); setDay(qd.day); }} className={chip(!custom && day === qd.day)}>
                <span className="block font-semibold">{qd.label}</span>
                <span className="block text-[11px] opacity-80">{dayLabel(qd.day)}</span>
              </button>
            ))}
            <button type="button" aria-pressed={custom} onClick={() => setCustom(true)} className={chip(custom)}>
              <span className="block font-semibold">Pick a date</span>
              <span className="block text-[11px] opacity-80">{custom ? dayLabel(day) : 'Any day ahead'}</span>
            </button>
          </div>
          {custom && (
            <input type="date" value={day} min={today} onChange={(e) => setDay(e.target.value)} aria-label="Date" className="mt-2 w-full rounded-md border bg-background px-2.5 py-1.5 text-[12.5px]" required />
          )}
          {weekend && <p className="mt-1.5 text-[11.5px] text-[var(--tone-amber-fg)]">That’s a weekend day — make sure someone works it.</p>}
        </fieldset>

        <fieldset className="mt-4">
          <legend className="mb-1.5 text-[11.5px] font-semibold">Who</legend>
          <div className="grid gap-2">
            <button type="button" aria-pressed={keep} onClick={() => setKeep(true)} className={chip(keep)}>
              <span className="block font-semibold">{oneOwner ? `Keep with ${firstName(oneOwner.name)}` : 'Keep each with its employee'}</span>
              <span className="block text-[11px] opacity-80">No one else’s queue changes.</span>
            </button>
            <button type="button" aria-pressed={!keep} onClick={() => setKeep(false)} className={chip(!keep)}>
              <span className="block font-semibold">Give to another employee</span>
              <span className="block text-[11px] opacity-80">Pick who below.</span>
            </button>
          </div>
          {!keep && (
            <div role="radiogroup" aria-label="Employee" className="mt-2 grid max-h-[180px] gap-1.5 overflow-y-auto sm:grid-cols-2">
              {people.map((p) => (
                <button key={p.id} type="button" role="radio" aria-checked={who === p.id} onClick={() => setWho(p.id)} className={`flex items-center gap-2 ${chip(who === p.id)}`}>
                  <Avatar name={firstName(p.name)} size="sm" />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{p.name}</span>
                    <span className="block text-[11px] opacity-80">{p.pending ? `${p.pending} pending` : 'Nothing pending'}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </fieldset>

        {/* What will happen, in one line. */}
        <p className="mt-4 rounded-lg bg-muted/50 px-3 py-2 text-[12px]">
          <span className="font-semibold">{n} call{n === 1 ? '' : 's'}</span> → {keep ? (oneOwner ? firstName(oneOwner.name) : 'their own employees') : target ? firstName(target.name) : '…'} on <span className="font-semibold">{day ? dayLabel(day) : '…'}</span>
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border px-3.5 py-1.5 text-[12.5px] font-semibold hover:bg-muted disabled:opacity-50">Cancel</button>
          <button type="submit" disabled={busy || !ready} className="rounded-md bg-primary px-3.5 py-1.5 text-[12.5px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {busy ? 'Moving…' : `Reschedule ${n === 1 ? 'call' : `${n} calls`}`}
          </button>
        </div>
      </form>
    </div>
  );
}

