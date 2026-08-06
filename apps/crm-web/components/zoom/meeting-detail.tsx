'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, X, ExternalLink, History, ScrollText, ClipboardList } from 'lucide-react';
import { zoomApi, STATUS_META, ACTION_LABEL, type ZoomMeeting, type ZoomMeetingStatus } from '@/lib/zoom';
import { Avatar } from '@/components/page-head';
import { ZoomTimeline } from '@/components/zoom-timeline';
import { formatInLeadZone } from '@/lib/timezone';
import { formatDateTime } from '@/lib/display-settings';

function StatusPill({ status }: { status: ZoomMeetingStatus }) {
  const m = STATUS_META[status];
  return (
    <span className="pill-tinted inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] font-semibold" style={{ '--pill': m.color } as React.CSSProperties}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  );
}
/**
 * Meeting times read on the CLIENT's clock with the zone named; audit stamps
 * (when a row was written) stay on the viewer's, since those record what the CRM
 * did rather than when the client is expected.
 */
const fmt = (iso: string | null, tz?: string | null) => (iso ? formatInLeadZone(iso, tz) : '—');
const fmtStamp = (iso: string | null) =>
  iso ? formatDateTime(iso) : '—';

/**
 * Full Zoom-meeting detail with Meeting History / Activity Log tabs.
 * Single source of truth — rendered both in the dashboard's right-side drawer
 * (pass `onClose`) and on the /zoom/[id] deep-link route (omit `onClose`).
 */
export function MeetingDetail({ id, onClose }: { id: string; onClose?: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'record' | 'history' | 'activity'>('record');
  const [reschedule, setReschedule] = useState('');

  const { data: m, isLoading } = useQuery({ queryKey: ['zoom-meeting', id], queryFn: () => zoomApi.get(id) });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['zoom-meeting', id] });
    qc.invalidateQueries({ queryKey: ['zoom-activities', id] });
    qc.invalidateQueries({ queryKey: ['zoom-timeline'] });
    qc.invalidateQueries({ queryKey: ['zoom'] });
  };
  async function act(fn: () => Promise<unknown>) { await fn(); refresh(); }

  if (isLoading || !m) return <div className="p-6 text-muted-foreground">Loading…</div>;

  const pending = m.status === 'scheduled' || m.status === 'rescheduled';

  return (
    <div className="space-y-6">
      {onClose ? (
        <button onClick={onClose} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:underline">
          <X className="h-4 w-4" /> Close
        </button>
      ) : (
        <Link href="/zoom" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:underline">
          <ArrowLeft className="h-4 w-4" /> Zoom Meetings
        </Link>
      )}

      {/* Header */}
      <div className="rounded-2xl border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Avatar name={m.lead?.businessName ?? '—'} size="lg" />
            <div>
              <h1 className="font-display text-[18px] font-semibold">{m.lead?.businessName ?? 'Unknown client'}</h1>
              <div className="text-[12.5px] text-muted-foreground">{m.title || `${m.durationMins} min Zoom meeting`}</div>
              <div className="mt-1.5 flex items-center gap-2"><StatusPill status={m.status} /><span className="text-[12px] text-muted-foreground">{fmt(m.scheduledAt, m.lead?.timezone)}</span></div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {m.joinUrl && (m.status === 'in_progress' || pending) && (
              <a href={m.joinUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-md bg-[#2D8CFF] px-3 py-2 text-[12.5px] font-semibold text-white">
                <ExternalLink className="h-4 w-4" /> Join
              </a>
            )}
            {pending && <button onClick={() => act(() => zoomApi.start(m.id))} className="rounded-md border px-3 py-2 text-[12.5px] font-semibold hover:bg-muted">Start</button>}
            {m.status !== 'completed' && m.status !== 'cancelled' && (
              <button onClick={() => act(() => zoomApi.cancel(m.id))} className="rounded-md border border-[var(--tone-red-line)] px-3 py-2 text-[12.5px] font-semibold text-[var(--tone-red-fg)] hover:bg-[var(--tone-red-bg)]">Cancel</button>
            )}
          </div>
        </div>

        {/* Reschedule */}
        {m.status !== 'completed' && m.status !== 'cancelled' && (
          <div className="mt-4 flex items-center gap-2">
            <input type="datetime-local" value={reschedule} onChange={(e) => setReschedule(e.target.value)} className="rounded-md border bg-background px-3 py-2 text-sm" />
            <button
              onClick={() => act(async () => { await zoomApi.update(m.id, { scheduledAt: reschedule }); setReschedule(''); })}
              disabled={!reschedule}
              className="rounded-md border px-3 py-2 text-[12.5px] font-semibold hover:bg-muted disabled:opacity-50"
            >
              Reschedule
            </button>
          </div>
        )}
      </div>

      {/* Client info */}
      <section className="rounded-2xl border bg-card p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold">Client</h2>
        <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          <Row label="Industry" value={m.lead?.industry} />
          <Row label="Phone" value={m.lead?.phone} />
          <Row label="Email" value={m.lead?.email} />
          <Row label="Location" value={m.lead ? `${m.lead.city}, ${m.lead.state}` : null} />
          <Row label="Lead status" value={m.lead?.status} />
          <Row label="Organizer" value={m.organizer?.name} />
          <Row label="Participants" value={m.participants} />
        </dl>
        {m.lead && <Link href={`/leads/${m.leadId}`} className="mt-3 inline-block text-[12px] font-semibold text-primary hover:underline">Open client profile →</Link>}
      </section>

      {/* Tabs */}
      <div className="rounded-2xl border bg-card shadow-sm">
        <div className="flex gap-1 overflow-x-auto border-b px-2 pt-2 sm:px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <TabBtn active={tab === 'record'} onClick={() => setTab('record')} icon={ClipboardList} label="Meeting Record" />
          <TabBtn active={tab === 'history'} onClick={() => setTab('history')} icon={History} label="Meeting History" />
          <TabBtn active={tab === 'activity'} onClick={() => setTab('activity')} icon={ScrollText} label="Activity Log" />
        </div>
        <div className="p-4 sm:p-5">
          {tab === 'record' ? <MeetingRecord m={m} /> : tab === 'history' ? <ZoomTimeline leadId={m.leadId} /> : <ActivityLog meetingId={m.id} tz={m.lead?.timezone} />}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────── Meeting Record tab (read-only) ────────────────────────
function MeetingRecord({ m }: { m: ZoomMeeting }) {
  const hasDetails = !!(m.outcome || m.summary || m.clientFeedback || m.decisions || m.actionItems || m.reason || m.agenda);
  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <Row label="Scheduled" value={fmt(m.scheduledAt, m.lead?.timezone)} />
        <Row label="Duration" value={`${m.durationMins} min`} />
        <Row label="Status" value={STATUS_META[m.status].label} />
        <Row label="Outcome" value={m.outcome} />
        <Row label="Next follow-up" value={m.followUpAt ? fmt(m.followUpAt, m.lead?.timezone) : null} />
      </dl>
      <div className="space-y-3">
        <Block label="Reason for meeting" value={m.reason} />
        <Block label="Agenda" value={m.agenda} />
        <Block label="Discussion summary" value={m.summary} />
        <Block label="Client feedback" value={m.clientFeedback} />
        <Block label="Decisions made" value={m.decisions} />
        <Block label="Action items" value={m.actionItems} />
      </div>
      {!hasDetails && (
        <p className="rounded-lg border border-dashed p-4 text-center text-[12.5px] text-muted-foreground">
          Discussion details appear here once the meeting is completed.
        </p>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: typeof History; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-2.5 text-[12px] font-semibold transition-colors sm:px-4 sm:text-[12.5px] ${active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
    >
      <Icon className="h-4 w-4 shrink-0" /> {label}
    </button>
  );
}

// ──────────────────────── Activity Log tab ────────────────────────
function ActivityLog({ meetingId, tz }: { meetingId: string; tz?: string | null }) {
  const { data: items = [], isLoading } = useQuery({ queryKey: ['zoom-activities', meetingId], queryFn: () => zoomApi.activities(meetingId) });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No activity recorded yet.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-[10.5px] uppercase tracking-[.08em] text-muted-foreground">
            <th className="px-3 py-2 font-semibold">Date &amp; time</th>
            <th className="px-3 py-2 font-semibold">User</th>
            <th className="px-3 py-2 font-semibold">Action</th>
            <th className="px-3 py-2 font-semibold">Previous</th>
            <th className="px-3 py-2 font-semibold">Updated</th>
            <th className="px-3 py-2 font-semibold">Remarks</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id} className="border-b last:border-0 align-top">
              <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">{fmtStamp(a.createdAt)}</td>
              <td className="px-3 py-2.5">{a.user?.name ?? 'System'}</td>
              <td className="px-3 py-2.5">
                <span className="font-semibold">{ACTION_LABEL[a.action] ?? a.action}</span>
                {a.field && <span className="ml-1 text-[11.5px] text-muted-foreground">({a.field})</span>}
              </td>
              <td className="px-3 py-2.5 text-muted-foreground">{fmtVal(a.field, a.oldValue, tz)}</td>
              <td className="px-3 py-2.5">{fmtVal(a.field, a.newValue, tz)}</td>
              <td className="px-3 py-2.5 text-muted-foreground">{a.remarks ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Dates stored as ISO are rendered human-friendly in the log — meeting times on
// the client's clock, so the trail agrees with the record it describes.
function fmtVal(field: string | null, value: string | null, tz?: string | null): string {
  if (!value) return '—';
  if (field === 'scheduledAt' || field === 'followUpAt') {
    const shown = formatInLeadZone(value, tz);
    if (shown) return shown;
  }
  return value.replace('_', ' ');
}

// ──────────────────────── Primitives ────────────────────────
function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-3 text-[12.5px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium capitalize">{value || '—'}</span>
    </div>
  );
}
function Block({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted-foreground">{label}</div>
      <div className="whitespace-pre-line text-[12.5px]">{value}</div>
    </div>
  );
}
