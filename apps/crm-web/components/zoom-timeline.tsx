'use client';

import { useQuery } from '@tanstack/react-query';
import { Video, Clock, ListChecks } from 'lucide-react';
import { zoomApi, STATUS_META, type ZoomMeetingStatus } from '@/lib/zoom';
import { formatInLeadZone } from '@/lib/timezone';

function StatusPill({ status }: { status: ZoomMeetingStatus }) {
  const m = STATUS_META[status];
  return (
    <span className="pill-tinted inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] font-semibold" style={{ '--pill': m.color } as React.CSSProperties}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  );
}
// Meeting and follow-up times read on the CLIENT's clock, with the zone named.
const fmt = (iso: string | null, tz?: string | null) => (iso ? formatInLeadZone(iso, tz) : '—');

function Line({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="mt-1 text-[12px] text-muted-foreground">
      <span className="font-semibold text-foreground">{label}:</span> <span className="whitespace-pre-line">{value}</span>
    </div>
  );
}

/** Complete chronological Zoom meeting history for one client (lead). */
export function ZoomTimeline({ leadId }: { leadId: string }) {
  const { data: meetings = [], isLoading } = useQuery({
    queryKey: ['zoom-timeline', leadId],
    queryFn: () => zoomApi.byLead(leadId),
  });

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Video className="h-4 w-4 text-[#2D8CFF]" /> Zoom Meeting History</h2>
        <span className="text-xs text-muted-foreground">{meetings.length} meeting{meetings.length === 1 ? '' : 's'}</span>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!isLoading && meetings.length === 0 && (
        <p className="text-sm text-muted-foreground">No Zoom meetings yet for this client.</p>
      )}

      <ol className="relative space-y-5 border-l-2 border-muted pl-5">
        {meetings.map((m) => (
          <li key={m.id} className="relative">
            <span className="absolute -left-[27px] top-1 grid h-4 w-4 place-items-center rounded-full border-2 border-card" style={{ background: STATUS_META[m.status].color }} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[12.5px] font-semibold">{fmt(m.scheduledAt, m.lead?.timezone)}</span>
              <div className="flex items-center gap-2">
                {m.joinUrl && (m.status === 'scheduled' || m.status === 'rescheduled' || m.status === 'in_progress') && (
                  <a href={m.joinUrl} target="_blank" rel="noopener noreferrer" className="rounded-md bg-[#2D8CFF] px-2 py-0.5 text-[10.5px] font-semibold text-white">Join</a>
                )}
                <StatusPill status={m.status} />
              </div>
            </div>
            {m.title && <div className="text-[12px] text-muted-foreground">{m.title}</div>}
            <Line label="Reason" value={m.reason} />
            <Line label="Agenda" value={m.agenda} />
            {m.outcome && <div className="mt-1 text-[12px]"><span className="font-semibold">Outcome:</span> {m.outcome}</div>}
            <Line label="Discussed" value={m.summary} />
            <Line label="Client feedback" value={m.clientFeedback} />
            <Line label="Decisions" value={m.decisions} />
            {m.actionItems && (
              <div className="mt-1.5 flex items-start gap-1.5 text-[12px]">
                <ListChecks className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="whitespace-pre-line">{m.actionItems}</div>
              </div>
            )}
            {m.followUpAt && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-[var(--tone-blue-fg)]">
                <Clock className="h-3.5 w-3.5" /> Follow-up: {fmt(m.followUpAt, m.lead?.timezone)}
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
