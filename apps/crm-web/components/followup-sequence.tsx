'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Check, CircleDashed, UserRound } from 'lucide-react';
import { callsApi, type LeadFollowup } from '@/lib/crm';
import { formatScheduleInLeadZone } from '@/lib/timezone';
import { OutcomePill } from '@/components/outcome-pill';
import { outcomesApi } from '@/lib/crm';

/**
 * A lead's follow-up ladder: Follow-Up 1 → 2 → 3 → 4 → 5, in order, with what
 * happened on each.
 *
 * The point of showing it as a ladder rather than a list is that the empty rungs
 * carry information too. A lead on its second call should show the road ahead,
 * and a lead that has used four of them should look different at a glance from
 * one that has used none — that is the judgement the ladder is there to support.
 *
 * Completed rungs are history and never change. At most one rung is open, and it
 * is the only one anybody has to act on.
 */
export function FollowupSequence({ leadId, timezone }: { leadId: string; timezone?: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ['lead', leadId, 'followups'],
    queryFn: () => callsApi.leadFollowups(leadId),
    // Matches the lead page around it, so a call logged elsewhere shows up here
    // without a reload.
    refetchInterval: 15_000,
  });
  const { data: outcomes = [] } = useQuery({ queryKey: ['outcomes-config'], queryFn: outcomesApi.list });

  const followups = data?.followups ?? [];
  const ladder = data?.ladder ?? 5;
  const used = followups.length;
  // Rungs not yet reached. Shown as a count rather than a row each: five empty
  // rows is a lot of screen for "nothing has happened here", and the number is
  // the whole message.
  const remaining = Math.max(ladder - used, 0);

  if (isLoading) return null;

  return (
    <section className="mt-5 rounded-2xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-[18px] py-3.5">
        <h3 className="font-display text-[14px] font-semibold">Follow-Up Sequence</h3>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10.5px] font-bold text-primary">
          {used === 0 ? 'None yet' : `${used} of ${ladder} used`}
        </span>
      </div>

      <div className="p-[14px]">
        {used === 0 ? (
          <p className="py-5 text-center text-sm text-muted-foreground">
            No follow-ups yet. The first callback booked on this lead becomes Follow-Up&nbsp;1.
          </p>
        ) : (
          <ol className="space-y-2">
            {followups.map((f) => (
              <FollowupRow key={f.id} followup={f} timezone={timezone} outcomes={outcomes} />
            ))}
          </ol>
        )}

        {used > 0 && remaining > 0 && (
          <p className="mt-2.5 text-center text-[11px] text-muted-foreground">
            {remaining} more {remaining === 1 ? 'rung' : 'rungs'} in the ladder — the next callback booked becomes
            Follow-Up&nbsp;{used + 1}.
          </p>
        )}
        {used >= ladder && (
          // The ladder is a layout, not a limit — say so, rather than letting a
          // full ladder read as "this lead can't be followed up again".
          <p className="mt-2.5 text-center text-[11px] text-muted-foreground">
            The ladder is full. Further callbacks keep counting up — the next becomes Follow-Up&nbsp;{used + 1}.
          </p>
        )}
      </div>
    </section>
  );
}

function FollowupRow({
  followup: f,
  timezone,
  outcomes,
}: {
  followup: LeadFollowup;
  timezone?: string | null;
  outcomes: { slug: string; name: string; color: string }[];
}) {
  const done = !!f.completedAt;
  const meta = outcomes.find((o) => o.slug === f.outcome);

  return (
    <li
      className={`rounded-[11px] border p-3 ${
        done ? 'bg-muted/40' : 'border-[var(--brand-mid)] bg-card shadow-[inset_3px_0_0_var(--brand)]'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`grid h-6 w-6 shrink-0 place-items-center rounded-[7px] text-[10.5px] font-bold ${
              done
                ? 'bg-[var(--tone-teal-bg)] text-[var(--tone-teal-fg)]'
                : 'bg-[var(--brand-surface)] text-[var(--brand-on-surface)]'
            }`}
          >
            {done ? <Check className="h-3.5 w-3.5" /> : f.seq}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-semibold">Follow-Up {f.seq}</div>
            {/* The customer's clock, with the zone named — the same rule every
                other scheduled time in the CRM follows. */}
            <div className="flex items-center gap-1.5 truncate text-[10.5px] text-muted-foreground">
              <CalendarClock className="h-3 w-3 shrink-0" />
              {formatScheduleInLeadZone(f.scheduledAt, timezone)}
            </div>
          </div>
        </div>

        {done ? (
          f.outcome ? (
            <OutcomePill name={meta?.name ?? f.outcome} color={meta?.color} />
          ) : (
            <span className="shrink-0 rounded-full bg-[var(--tone-teal-bg)] px-2 py-[2px] text-[10px] font-semibold text-[var(--tone-teal-fg)]">
              Completed
            </span>
          )
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--tone-amber-bg)] px-2 py-[2px] text-[10px] font-semibold text-[var(--tone-amber-fg)]">
            <CircleDashed className="h-3 w-3" /> Pending
          </span>
        )}
      </div>

      {f.comments && (
        <p className="mt-2 whitespace-pre-wrap border-t pt-2 text-[11.5px] leading-relaxed text-foreground">
          {f.comments}
        </p>
      )}

      {/* Who owed it, and who actually worked it. Named separately because they
          differ often enough to matter — a lead reassigned mid-sequence, or a
          manager picking up a rung on someone's day off. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-muted-foreground">
        {f.assignedTo && (
          <span className="inline-flex items-center gap-1">
            <UserRound className="h-3 w-3" /> {f.assignedTo.name}
          </span>
        )}
        {done && f.completedBy && f.completedBy.id !== f.assignedTo?.id && (
          <span>Worked by {f.completedBy.name}</span>
        )}
      </div>
    </li>
  );
}
