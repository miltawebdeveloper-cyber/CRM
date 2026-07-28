'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Video, CalendarClock, PlayCircle, CheckCircle2, Plus, X } from 'lucide-react';
import { zoomApi, STATUS_META, type ZoomMeeting, type ZoomMeetingStatus, type CompleteZoomMeeting } from '@/lib/zoom';
import { leadsApi } from '@/lib/leads';
import { PageHead, Avatar } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { MeetingDetail } from '@/components/zoom/meeting-detail';
import { describeWallClock, formatInLeadZone, zoneLabel } from '@/lib/timezone';

const FILTERS: { value: '' | ZoomMeetingStatus; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'rescheduled', label: 'Rescheduled' },
];

function StatusPill({ status }: { status: ZoomMeetingStatus }) {
  const m = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11.5px] font-semibold" style={{ color: m.color, background: `${m.color}1f` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  );
}

// Meeting times read on the CLIENT's clock, with the zone named.
const fmtDateTime = (iso: string | null, tz?: string | null) => (iso ? formatInLeadZone(iso, tz) : '—');
// datetime-local needs `yyyy-MM-ddTHH:mm` in local time.
const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export default function ZoomPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'' | ZoomMeetingStatus>('');
  const [q, setQ] = useState('');
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [completeFor, setCompleteFor] = useState<ZoomMeeting | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const { data: meetings = [], isLoading } = useQuery({
    queryKey: ['zoom', status, q],
    queryFn: () => zoomApi.list({ status: status || undefined, q: q || undefined }),
  });

  const kpis = useMemo(() => {
    const today = new Date().toDateString();
    return {
      today: meetings.filter((m) => new Date(m.scheduledAt).toDateString() === today && m.status !== 'cancelled').length,
      scheduled: meetings.filter((m) => m.status === 'scheduled' || m.status === 'rescheduled').length,
      inProgress: meetings.filter((m) => m.status === 'in_progress').length,
      completed: meetings.filter((m) => m.status === 'completed').length,
    };
  }, [meetings]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['zoom'] });
    qc.invalidateQueries({ queryKey: ['zoom-timeline'] });
  };

  async function act(fn: () => Promise<unknown>) {
    await fn();
    refresh();
  }

  return (
    <div>
      <PageHead>
        <button onClick={() => setScheduleOpen(true)} className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[13px] font-semibold text-primary-foreground">
          <Plus className="h-4 w-4" /> Schedule Meeting
        </button>
      </PageHead>

      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        <KpiCard icon={CalendarClock} iconBg="#e7f0f8" iconColor="#2c5d8f" value={kpis.today} label="Today" />
        <KpiCard icon={Video} iconBg="#eaf1ea" iconColor="#5a725b" value={kpis.scheduled} label="Upcoming" />
        <KpiCard icon={PlayCircle} iconBg="#fbf3e2" iconColor="#c98a18" value={kpis.inProgress} label="In Progress" />
        <KpiCard icon={CheckCircle2} iconBg="#e4f2e4" iconColor="#317d34" value={kpis.completed} label="Completed" />
      </div>

      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.value || 'all'}
              onClick={() => setStatus(f.value)}
              className={`rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${status === f.value ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search client…"
          className="ml-auto w-56 rounded-md border bg-background px-3 py-2 text-sm"
        />
      </div>

      {/* List */}
      <div className="rounded-2xl border bg-card shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-[11px] uppercase tracking-[.08em] text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Client</th>
                <th className="px-4 py-3 font-semibold">Industry</th>
                <th className="px-4 py-3 font-semibold">Scheduled</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Outcome</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
              )}
              {!isLoading && meetings.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No Zoom meetings yet. Schedule one to get started.</td></tr>
              )}
              {meetings.map((m) => (
                <tr key={m.id} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <button onClick={() => setDetailId(m.id)} className="flex items-center gap-2.5 text-left">
                      <Avatar name={m.lead?.businessName ?? '—'} />
                      <div className="min-w-0">
                        <div className="truncate font-semibold hover:underline">{m.lead?.businessName ?? 'Unknown'}</div>
                        <div className="truncate text-[11.5px] text-muted-foreground">{m.title || `${m.durationMins} min meeting`}</div>
                      </div>
                    </button>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{m.lead?.industry || '—'}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{fmtDateTime(m.scheduledAt, m.lead?.timezone)}</td>
                  <td className="px-4 py-3"><StatusPill status={m.status} /></td>
                  <td className="px-4 py-3 text-muted-foreground">{m.outcome || '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      {m.joinUrl && (
                        <a href={m.joinUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-md bg-[#2D8CFF] px-2.5 py-1.5 text-[12px] font-semibold text-white">
                          <Video className="h-3.5 w-3.5" /> Join
                        </a>
                      )}
                      {(m.status === 'scheduled' || m.status === 'rescheduled') && (
                        <button onClick={() => act(() => zoomApi.start(m.id))} className="rounded-md border px-2.5 py-1.5 text-[12px] font-semibold hover:bg-muted">Start</button>
                      )}
                      {m.status === 'in_progress' && (
                        <button onClick={() => setCompleteFor(m)} className="rounded-md bg-[#317d34] px-2.5 py-1.5 text-[12px] font-semibold text-white">Complete</button>
                      )}
                      <button onClick={() => setDetailId(m.id)} className="rounded-md border px-2.5 py-1.5 text-[12px] font-semibold hover:bg-muted">Details</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {scheduleOpen && <ScheduleModal onClose={() => setScheduleOpen(false)} onSaved={() => { setScheduleOpen(false); refresh(); }} />}
      {completeFor && <CompleteModal meeting={completeFor} onClose={() => setCompleteFor(null)} onSaved={() => { setCompleteFor(null); refresh(); }} />}

      {/* Right-side detail drawer (slide-over) */}
      {detailId && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => setDetailId(null)}>
          <div className="h-full w-full max-w-2xl overflow-y-auto bg-background p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <MeetingDetail id={detailId} onClose={() => setDetailId(null)} />
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────── Schedule modal ────────────────────────
function ScheduleModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { data: leads = [] } = useQuery({ queryKey: ['leads'], queryFn: () => leadsApi.list() });
  const [leadId, setLeadId] = useState('');
  // The chosen client decides which clock the meeting is booked on.
  const selectedLead = leads.find((l) => l.id === leadId);
  const [when, setWhen] = useState(() => {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return toLocalInput(d);
  });
  const [duration, setDuration] = useState(30);
  const [title, setTitle] = useState('');
  const [joinUrl, setJoinUrl] = useState('');
  const [passcode, setPasscode] = useState('');
  const [participants, setParticipants] = useState('');
  const [agenda, setAgenda] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!leadId || !when) return;
    setBusy(true);
    try {
      await zoomApi.create({
        leadId,
        // The wall clock exactly as typed. The API reads it in the selected
        // client's zone; converting here would resolve it in the browser's.
        scheduledAt: when,
        durationMins: duration,
        title: title || undefined,
        joinUrl: joinUrl || undefined,
        passcode: passcode || undefined,
        participants: participants || undefined,
        agenda: agenda || undefined,
        reason: reason || undefined,
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Schedule Zoom Meeting" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Client">
          <select value={leadId} onChange={(e) => setLeadId(e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm">
            <option value="">Select a client…</option>
            {leads.map((l) => (
              <option key={l.id} value={l.id}>{l.businessName} — {l.city}, {l.state}</option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* The zone is part of the field label, because the time is booked on the
              CLIENT's clock and a rep entering "2 PM" has to know whose 2 PM. */}
          <Field label={`Date & time${selectedLead ? ` (${selectedLead.timezone} / ${zoneLabel(selectedLead.timezone)})` : ''}`}>
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </Field>
          <Field label="Duration (min)">
            <input type="number" min={5} max={480} value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </Field>
        </div>
        {selectedLead && when && (
          <p className="-mt-1 text-[11.5px] text-muted-foreground">
            Saved as <span className="font-semibold text-foreground">{describeWallClock(when, selectedLead.timezone)}</span> for {selectedLead.businessName}.
          </p>
        )}
        <Field label="Title (optional)">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Bookkeeping onboarding call" className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Zoom join link">
            <input value={joinUrl} onChange={(e) => setJoinUrl(e.target.value)} placeholder="https://zoom.us/j/…" className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </Field>
          <Field label="Passcode">
            <input value={passcode} onChange={(e) => setPasscode(e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </Field>
        </div>
        <Field label="Participants">
          <input value={participants} onChange={(e) => setParticipants(e.target.value)} placeholder="names / emails" className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
        </Field>
        <Field label="Reason for meeting">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this meeting being held?" className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
        </Field>
        <Field label="Agenda (optional)">
          <textarea value={agenda} onChange={(e) => setAgenda(e.target.value)} rows={2} className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm" />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md border px-4 py-2 text-sm font-semibold hover:bg-muted">Cancel</button>
        <button onClick={save} disabled={!leadId || !when || busy} className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">Schedule</button>
      </div>
    </Modal>
  );
}

// ──────────────────────── Complete modal ────────────────────────
function CompleteModal({ meeting, onClose, onSaved }: { meeting: ZoomMeeting; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<CompleteZoomMeeting>({
    outcome: '', reason: meeting.reason ?? '', summary: '', clientFeedback: '', decisions: '', actionItems: '', notes: '', followUpAt: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof CompleteZoomMeeting, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setBusy(true);
    try {
      await zoomApi.complete(meeting.id, {
        outcome: form.outcome || undefined,
        reason: form.reason || undefined,
        summary: form.summary || undefined,
        clientFeedback: form.clientFeedback || undefined,
        decisions: form.decisions || undefined,
        actionItems: form.actionItems || undefined,
        notes: form.notes || undefined,
        // Wall clock as typed — read in the client's zone by the API, like every
        // other scheduled time on this record.
        followUpAt: form.followUpAt || undefined,
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Complete meeting — ${meeting.lead?.businessName ?? ''}`} onClose={onClose}>
      <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
        <Field label="Outcome">
          <input value={form.outcome} onChange={(e) => set('outcome', e.target.value)} placeholder="e.g. Signed up, Needs proposal, Not interested" className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
        </Field>
        <Field label="Reason for meeting (why it was conducted)">
          <input value={form.reason} onChange={(e) => set('reason', e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
        </Field>
        <Field label="Discussion summary (what was discussed)">
          <textarea value={form.summary} onChange={(e) => set('summary', e.target.value)} rows={3} className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm" />
        </Field>
        <Field label="Client feedback">
          <textarea value={form.clientFeedback} onChange={(e) => set('clientFeedback', e.target.value)} rows={2} className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm" />
        </Field>
        <Field label="Decisions made">
          <textarea value={form.decisions} onChange={(e) => set('decisions', e.target.value)} rows={2} className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm" />
        </Field>
        <Field label="Action items (one per line)">
          <textarea value={form.actionItems} onChange={(e) => set('actionItems', e.target.value)} rows={3} placeholder={'Send pricing PDF\nSchedule follow-up'} className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm" />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={`Follow-up / next meeting (${meeting.lead?.timezone ?? 'EST'})`}>
            <input type="datetime-local" value={form.followUpAt} onChange={(e) => set('followUpAt', e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </Field>
          <Field label="Private notes">
            <input value={form.notes} onChange={(e) => set('notes', e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </Field>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md border px-4 py-2 text-sm font-semibold hover:bg-muted">Cancel</button>
        <button onClick={save} disabled={busy} className="rounded-md bg-[#317d34] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Save & complete</button>
      </div>
    </Modal>
  );
}

// ──────────────────────── Small primitives ────────────────────────
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h3 className="font-display text-[16px] font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-muted"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
