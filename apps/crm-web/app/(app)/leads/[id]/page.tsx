'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, MessageSquare, Info, Pencil } from 'lucide-react';
import { leadsApi, movementLabel, type UpdateLeadInput } from '@/lib/leads';
import { assignmentsApi, communicationsApi, countriesApi, sameDayConflicts, type SameDayConflict } from '@/lib/crm';
import { leadEditChanges } from '@/lib/lead-edit';
import { pushToast } from '@/lib/toast';
import { ReassignConfirm } from '@/components/reassign-confirm';
import { useCanCall } from '@/lib/use-can-call';
import { QuoStatusBadge } from '@/components/quo-status-badge';
import { ZoomTimeline } from '@/components/zoom-timeline';
import { FollowupSequence } from '@/components/followup-sequence';
import { LeadActivityDrawer } from '@/components/lead-activity-log';
import { api } from '@/lib/api';
import { invalidateLeadComment } from '@/lib/sync';
import { formatDateTime, formatTime } from '@/lib/display-settings';
import { leadDate, leadDateTime, wallClockInLeadZone } from '@/lib/timezone';
import { countryOfZone, timezoneLabel, useLeadTimezones, zoneMatchesCountry } from '@/lib/timezone';

const SMS_TEMPLATES: { label: string; text: (name: string) => string }[] = [
  { label: 'Intro', text: (n) => `Hi, this is the team at Milta reaching out about ${n}. Is now a good time to chat?` },
  { label: 'Follow-up', text: () => `Just following up on our last conversation — happy to answer any questions when you're free.` },
  { label: 'Missed you', text: () => `Sorry we missed you! Reply here or let us know a good time to call back.` },
];

export default function LeadDetailPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [smsOpen, setSmsOpen] = useState(false);
  const [smsBody, setSmsBody] = useState('');

  const { data: lead, isLoading } = useQuery({
    queryKey: ['lead', id],
    queryFn: () => leadsApi.get(id),
    // Auto-refresh so a call that completes/syncs in the background (status,
    // outcome, callback) updates the page without a manual reload.
    refetchInterval: 15000,
  });

  // Current user — the Activity Log is restricted to Admin & Team Lead.
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });

  const { data: countryDefs = [] } = useQuery({ queryKey: ['countries-config'], queryFn: countriesApi.list });
  // A lead's own country stays selectable even once deactivated, so editing
  // an old lead never silently blanks a retired value out from under it.
  const countryOptions = lead?.country && !countryDefs.some((c) => c.code === lead.country)
    ? [{ id: lead.country, code: lead.country, name: lead.country, defaultTimezone: null, sortOrder: -1, isActive: false }, ...countryDefs]
    : countryDefs;
  // Refuse to dial before the API would reject the call (no assigned caller ID).
  const { dial, callingEnabled } = useCanCall();
  const canSeeActivity = me?.role === 'admin' || me?.role === 'team_leader';
  const canEdit = canSeeActivity; // managers may edit lead fields
  const [showActivity, setShowActivity] = useState(false);

  // ── Lead edit (managers only) ──
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<UpdateLeadInput>({});
  // What the form opened with — the save sends only what differs from it. See
  // lib/lead-edit for why sending the whole form back was damaging.
  const [initial, setInitial] = useState<UpdateLeadInput>({});
  const leadTzOpts = useLeadTimezones(form.country || null);
  // Who the lead can be handed to — the employees the assign dialog offers.
  const { data: assignSummary } = useQuery({ queryKey: ['assignments-summary'], queryFn: assignmentsApi.summary, enabled: canEdit && editing });
  // The once-a-day rule: a lead already handed over today needs confirming
  // before it moves again. The server says which, this asks.
  const [sameDay, setSameDay] = useState<SameDayConflict[] | null>(null);
  const edit = useMutation({
    // A lead with no zone seeds `timezone: ''`, which the API's `@IsEnum(Timezone)`
    // rejects outright — so saving ANY edit to a zone-less lead used to fail with
    // a validation error that named a field the manager hadn't touched. Omit the
    // key instead: `@IsOptional()` then leaves the stored zone alone.
    // Only what changed (lib/lead-edit), which also leaves a blank zone out.
    mutationFn: (confirmSameDay: boolean) =>
      leadsApi.update(id, { ...leadEditChanges(initial, form), ...(confirmSameDay ? { confirmSameDayReassign: true } : {}) }),
    // Errors are handled below: a same-day refusal is a question, not a failure.
    meta: { successMessage: 'Changes saved', suppressErrorToast: true },
    onError: (err) => {
      const conflicts = sameDayConflicts(err);
      if (conflicts) return setSameDay(conflicts);
      pushToast('error', (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed to save changes.');
    },
    onSuccess: () => {
      setSameDay(null);
      // The form carries a Comments field, and saving it APPENDS to the lead's
      // shared trail server-side — so this refreshes every module that shows
      // comments, the Calling Panel included, rather than just this page. Covers
      // ['lead'], ['leads'], ['lead-comments'], ['caller-leads'] and
      // ['activities']; see lib/sync.ts.
      invalidateLeadComment(qc);
      // The edit form can reassign the lead (`caller`) and can close it, so the
      // owner's assignment summary and KPI cards move with this save too.
      qc.invalidateQueries({ queryKey: ['assignments-summary'] });
      qc.invalidateQueries({ queryKey: ['caller-dash'] });
      setEditing(false);
    },
  });

  const { data: timeline = [] } = useQuery({
    queryKey: ['lead', id, 'timeline'],
    queryFn: () => communicationsApi.timeline(id),
    // Poll so a completed call's recording, AI summary and transcript appear on
    // the conversation timeline automatically once the webhook syncs them.
    refetchInterval: 12000,
  });

  const refreshTimeline = () => {
    qc.invalidateQueries({ queryKey: ['lead', id, 'timeline'] });
    qc.invalidateQueries({ queryKey: ['lead', id, 'activities'] });
  };
  const sms = useMutation({
    mutationFn: () => communicationsApi.sendSms(id, smsBody),
    meta: { successMessage: 'Message sent' },
    onSuccess: () => { setSmsBody(''); setSmsOpen(false); refreshTimeline(); },
  });

  const { data: logs = [] } = useQuery({
    queryKey: ['lead', id, 'quo-logs'],
    queryFn: () => leadsApi.quoLogs(id),
    refetchInterval: 20000,
  });

  const sync = useMutation({
    mutationFn: () => leadsApi.syncToQuo(id),
    meta: { suppressErrorToast: true }, // Quo errors surface in the panel below
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead', id] });
      qc.invalidateQueries({ queryKey: ['lead', id, 'quo-logs'] });
      qc.invalidateQueries({ queryKey: ['leads'] });
    },
  });

  if (isLoading || !lead) {
    return <div className="p-6 text-muted-foreground">Loading…</div>;
  }

  const field = (label: string, value: React.ReactNode) => (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value || '—'}</dd>
    </div>
  );

  // Seed the edit form from the current lead, then open the inline editor.
  const startEdit = () => {
    // Dates are pre-filled as the lead's wall clock, to the minute — the value
    // the API reads back on that same clock. They used to be cut to their UTC
    // calendar day, which both dropped the time and, for a US evening, named
    // the wrong day.
    const onClock = (v: string | null | undefined) => (v ? wallClockInLeadZone(v, lead.timezone) : '');
    const seed: UpdateLeadInput = {
      businessName: lead.businessName,
      phone: lead.phone,
      email: lead.email ?? '',
      state: lead.state,
      city: lead.city,
      timezone: lead.timezone ?? '',
      status: lead.status,
      contactName: lead.contactName ?? '',
      industry: lead.industry ?? '',
      title: lead.title ?? '',
      leadCategory: lead.leadCategory ?? '',
      comments: lead.comments ?? '',
      nextFollowUpDate: onClock(lead.nextFollowUpDate),
      // The owner's email, not their name: it is unique, and it is what the
      // Assigned To list below uses as each option's value.
      caller: lead.assignedTo?.email ?? '',
      leadGenerationId: lead.leadGenerationId ?? '',
      leadSource: lead.leadSource ?? '',
      contactName2: lead.contactName2 ?? '',
      altPhone: lead.altPhone ?? '',
      website: lead.website ?? '',
      socialMedia: lead.socialMedia ?? '',
      country: lead.country ?? '',
      companySize: lead.companySize ?? '',
      foundedYear: lead.foundedYear ?? '',
      address: lead.address ?? '',
      callStatus: lead.callStatus ?? '',
      firstContact: onClock(lead.firstContact),
      lastContact: onClock(lead.lastContact),
      followupCount: lead.followupCount ?? undefined,
      meetingDate: onClock(lead.meetingDate),
      lostReason: lead.lostReason ?? '',
    };
    setForm(seed);
    setInitial(seed);
    setEditing(true);
  };
  const set = (k: keyof UpdateLeadInput, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const STATUS_VALUES = ['new', 'in_progress', 'contacted', 'interested', 'closed', 'rejected'] as const;
  const editInput = 'w-full rounded-md border bg-background px-3 py-2 text-sm';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <Link href="/leads" className="text-sm text-muted-foreground hover:underline">
          ← Leads
        </Link>
        <h1 className="text-lg font-semibold">{lead.leadId}</h1>
        <div className="ml-auto flex items-center gap-2">
          {/* Not rendered while calling is disabled — the button's only job is to
              dial, and offering it when nothing can be dialled just misleads. */}
          {callingEnabled && (
            <button
              onClick={() => {
                // Check first: the app handoff can't be taken back, so a rep with no
                // caller ID would really dial the customer on a call the CRM refuses
                // to log. `dial` launches the Quo app inside the click gesture
                // (browsers only hand a custom scheme to an app from a real click),
                // then we go to the panel to log + monitor (autocall logs only, it
                // does not dial a second time).
                if (!dial(lead.phone)) return;
                router.push(`/calling?leadId=${lead.id}&autocall=1`);
              }}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[12.5px] font-semibold text-primary-foreground hover:opacity-90"
            >
              <Phone className="h-4 w-4" /> Call
            </button>
          )}
          <button
            onClick={() => setSmsOpen((v) => !v)}
            className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[12.5px] font-semibold hover:bg-muted"
          >
            <MessageSquare className="h-4 w-4" /> Send SMS
          </button>
          {canEdit && !editing && (
            <button
              onClick={startEdit}
              title="Edit lead"
              aria-label="Edit lead"
              className="inline-flex items-center gap-2 rounded-md border bg-card px-[12px] py-[9px] text-[12.5px] font-semibold hover:bg-muted"
            >
              <Pencil className="h-4 w-4" /> Edit
            </button>
          )}
          {canSeeActivity && (
            <button
              onClick={() => setShowActivity(true)}
              title="Activity log"
              aria-label="Activity log"
              className="inline-flex items-center gap-2 rounded-md border bg-card px-[12px] py-[9px] text-[12.5px] font-semibold hover:bg-muted"
            >
              <Info className="h-4 w-4" /> Activity
            </button>
          )}
        </div>
      </div>

      {smsOpen && (
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] font-semibold">Send SMS to {lead.phone}</span>
            <div className="ml-auto flex flex-wrap gap-1.5">
              {SMS_TEMPLATES.map((t) => (
                <button key={t.label} onClick={() => setSmsBody(t.text(lead.contactName ?? lead.leadId))} className="rounded-full border px-2.5 py-1 text-[11px] font-medium hover:bg-muted">
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <textarea value={smsBody} onChange={(e) => setSmsBody(e.target.value)} rows={3} placeholder="Type a message or pick a template…" className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">{smsBody.length}/1600{sms.isError ? ' · failed to send' : ''}</span>
            <div className="flex gap-2">
              <button onClick={() => { setSmsOpen(false); setSmsBody(''); }} className="rounded-md border bg-card px-3 py-2 text-[12.5px] font-semibold hover:bg-muted">Cancel</button>
              <button onClick={() => sms.mutate()} disabled={sms.isPending || !smsBody.trim()} className="rounded-md bg-primary px-4 py-2 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-60">
                {sms.isPending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Lead info */}
        <div className="rounded-lg border bg-card p-5 lg:col-span-1">
          <h2 className="mb-4 text-sm font-semibold">Lead Details</h2>
          {!editing ? (
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {field('Lead ID', lead.leadId)}
              {field('Lead Generation ID', lead.leadGenerationId)}
              {/* The original creation stamp, to the minute, and the day the
                  lead is currently queued for. Both, because they answer
                  different questions and drift apart the moment a lead is
                  reassigned or carried into the next day. */}
              {field('Created Date & Time', lead.createdAt ? leadDateTime(lead.createdAt, lead.timezone) : null)}
              {field('Scheduled Date', lead.assignedAt ? leadDate(lead.assignedAt, lead.timezone) : null)}
              {field('Movement', movementLabel(lead) || null)}
              {field('Lead Source', lead.leadSource)}
              {field('Company Name', lead.businessName)}
              {field('Contact Person', lead.contactName)}
              {field('Designation', lead.contactName2)}
              {field('Phone', lead.phone)}
              {field('Alt Phone', lead.altPhone)}
              {field('Email', lead.email)}
              {field('Website', lead.website)}
              {field('Social Media', lead.socialMedia)}
              {field('Country', lead.country)}
              {field('State', lead.state)}
              {field('City', lead.city)}
              {field('Time Zone', lead.timezone)}
              {field('Industry', lead.industry)}
              {field('Company Size', lead.companySize)}
              {field('Founded Year', lead.foundedYear)}
              {field('Address', lead.address)}
              {field('Assigned To', lead.assignedTo?.name)}
              {field('Call Status', lead.callStatus)}
              {field('First Contact', lead.firstContact ? leadDateTime(lead.firstContact, lead.timezone) : null)}
              {field('Last Contact', lead.lastContact ? leadDateTime(lead.lastContact, lead.timezone) : null)}
              {field('Next Follow-up', lead.nextFollowUpDate ? leadDateTime(lead.nextFollowUpDate, lead.timezone) : null)}
              {field('Follow-up Count', lead.followupCount != null ? String(lead.followupCount) : null)}
              {field('Meeting Date', lead.meetingDate ? leadDateTime(lead.meetingDate, lead.timezone) : null)}
              {field('Lost Reason', lead.lostReason)}
              {field('Status', <span className="capitalize">{lead.status.replace('_', ' ')}</span>)}
            </dl>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (Object.keys(leadEditChanges(initial, form)).length === 0) {
                  setEditing(false);
                  pushToast('info', 'No changes to save.');
                  return;
                }
                edit.mutate(false);
              }}
              className="space-y-3"
            >
              <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Lead Generation ID</span>
                <input className={editInput} value={form.leadGenerationId ?? ''} onChange={(e) => set('leadGenerationId', e.target.value)} /></label>
              <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Lead Source</span>
                <input className={editInput} value={form.leadSource ?? ''} onChange={(e) => set('leadSource', e.target.value)} /></label>
              <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Company Name</span>
                <input className={editInput} value={form.businessName ?? ''} onChange={(e) => set('businessName', e.target.value)} required /></label>
              <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Status</span>
                <select className={editInput} value={form.status ?? ''} onChange={(e) => set('status', e.target.value)}>
                  {STATUS_VALUES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                </select></label>
              <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Contact Person (Primary)</span>
                <input className={editInput} value={form.contactName ?? ''} onChange={(e) => set('contactName', e.target.value)} /></label>
              <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Designation</span>
                <input className={editInput} value={form.contactName2 ?? ''} onChange={(e) => set('contactName2', e.target.value)} /></label>
              <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Phone</span>
                <input className={editInput} value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} required /></label>
              <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Alt Phone</span>
                <input className={editInput} value={form.altPhone ?? ''} onChange={(e) => set('altPhone', e.target.value)} /></label>
              <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Email</span>
                <input type="email" className={editInput} value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} /></label>
              <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Website</span>
                <input className={editInput} value={form.website ?? ''} onChange={(e) => set('website', e.target.value)} /></label>
              <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Social Media</span>
                <input className={editInput} value={form.socialMedia ?? ''} onChange={(e) => set('socialMedia', e.target.value)} /></label>
              {/* Field pairs sit side by side from `sm` up and stack below it.
                  Fixed at two columns they left each input about 165px on a
                  375px phone — narrow enough that a city or an email scrolled
                  inside its own box while being typed. */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Country</span>
                  <select className={editInput} value={form.country ?? ''} onChange={(e) => {
                    // Keep the zone if it belongs to the new country, else use its default.
                    const c = e.target.value;
                    const fallback = countryOptions.find((d) => d.code === c)?.defaultTimezone ?? '';
                    setForm((f) => ({ ...f, country: c, timezone: f.timezone && zoneMatchesCountry(f.timezone, c || null) ? f.timezone : fallback || f.timezone }));
                  }}>
                    <option value="">— none —</option>
                    {countryOptions.map((c) => <option key={c.id} value={c.code}>{c.name}</option>)}
                  </select></label>
                <label className="block space-y-1 text-xs"><span className="text-muted-foreground">State</span>
                  <input className={editInput} value={form.state ?? ''} onChange={(e) => set('state', e.target.value)} required /></label>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-xs"><span className="text-muted-foreground">City</span>
                  <input className={editInput} value={form.city ?? ''} onChange={(e) => set('city', e.target.value)} required /></label>
                <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Timezone</span>
                  <select className={editInput} value={form.timezone ?? ''} onChange={(e) => set('timezone', e.target.value)}>
                    {/* A lead with no zone shows blank rather than displaying
                        Eastern, which is what this control used to do: the value
                        behind it was still empty, so the form showed a zone the
                        lead did not have. Disabled, so blank can be shown but not
                        chosen — clearing a zone is not an edit this form offers. */}
                    <option value="" disabled>— Not set —</option>
                    {/* A zone since deactivated in Admin stays selectable for the lead
                        still on it, so opening the form never silently blanks it. */}
                    {form.timezone && !leadTzOpts.some((t) => t.value === form.timezone) && (
                      <option value={form.timezone}>{timezoneLabel(form.timezone)} ({countryOfZone(form.timezone) && !zoneMatchesCountry(form.timezone, form.country || null) ? `not in ${form.country}` : 'inactive'})</option>
                    )}
                    {leadTzOpts.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select></label>
              </div>
              {/* A list, not free text: a typo used to fail only when the server
                  couldn't match it, and a name shared by two users could match
                  the wrong one. The current owner stays listed even when they
                  are not an employee (a team leader holding a lead, say). */}
              <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Assigned To</span>
                <select className={editInput} value={form.caller ?? ''} onChange={(e) => set('caller', e.target.value)}>
                  <option value="">— Unassigned —</option>
                  {lead.assignedTo && !(assignSummary?.callers ?? []).some((c) => c.email === lead.assignedTo!.email) && (
                    <option value={lead.assignedTo.email}>{lead.assignedTo.name}</option>
                  )}
                  {(assignSummary?.callers ?? []).map((c) => (
                    <option key={c.id} value={c.email}>{c.name} · {c.leadCount.toLocaleString()} lead{c.leadCount === 1 ? '' : 's'}</option>
                  ))}
                </select></label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Industry</span>
                  <input className={editInput} value={form.industry ?? ''} onChange={(e) => set('industry', e.target.value)} /></label>
                <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Company Size</span>
                  <input className={editInput} value={form.companySize ?? ''} onChange={(e) => set('companySize', e.target.value)} /></label>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Founded Year</span>
                  <input className={editInput} value={form.foundedYear ?? ''} onChange={(e) => set('foundedYear', e.target.value)} /></label>
                <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Call Status</span>
                  <input className={editInput} value={form.callStatus ?? ''} onChange={(e) => set('callStatus', e.target.value)} /></label>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-xs"><span className="text-muted-foreground">First Contact</span>
                  <input type="datetime-local" className={editInput} value={form.firstContact ?? ''} onChange={(e) => set('firstContact', e.target.value)} /></label>
                <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Last Contact</span>
                  <input type="datetime-local" className={editInput} value={form.lastContact ?? ''} onChange={(e) => set('lastContact', e.target.value)} /></label>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Next Follow-up</span>
                  <input type="datetime-local" className={editInput} value={form.nextFollowUpDate ?? ''} onChange={(e) => set('nextFollowUpDate', e.target.value)} />
                  <span className="block text-[10.5px] text-muted-foreground">Books the callback — reminders follow it. Clear it to cancel.</span></label>
                <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Follow-up Count</span>
                  <input type="number" className={editInput} value={form.followupCount ?? ''} onChange={(e) => set('followupCount', e.target.value)} /></label>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Meeting Date</span>
                  <input type="datetime-local" className={editInput} value={form.meetingDate ?? ''} onChange={(e) => set('meetingDate', e.target.value)} /></label>
                <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Lost Reason</span>
                  <input className={editInput} value={form.lostReason ?? ''} onChange={(e) => set('lostReason', e.target.value)} /></label>
              </div>
              <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Address</span>
                <input className={editInput} value={form.address ?? ''} onChange={(e) => set('address', e.target.value)} /></label>
              <div className="flex items-center gap-2 pt-1">
                <button type="submit" disabled={edit.isPending} className="rounded-md bg-primary px-4 py-2 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-60">
                  {edit.isPending ? 'Saving…' : 'Save changes'}
                </button>
                <button type="button" onClick={() => setEditing(false)} className="rounded-md border bg-card px-3 py-2 text-[12.5px] font-semibold hover:bg-muted">Cancel</button>
                {edit.isError && <span className="text-[11.5px] text-[var(--tone-red-fg)]">Failed to save</span>}
              </div>
            </form>
          )}
        </div>

        {/* Quo integration panel */}
        <div className="rounded-lg border bg-card p-5 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold">Quo Integration</h2>
              <QuoStatusBadge status={lead.quoStatus} />
            </div>
            <button
              onClick={() => sync.mutate()}
              disabled={sync.isPending || lead.quoStatus === 'pending'}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {sync.isPending
                ? 'Sending…'
                : lead.quoStatus === 'synced'
                  ? 'Re-send to Quo'
                  : 'Send to Quo'}
            </button>
          </div>

          {/* The one panel on this page still read on the READER's clock, and
              deliberately. Everything above belongs to the lead and is stated on
              the lead's zone; these two are our integration's own behaviour —
              when this server last pushed the contact and how each attempt went.
              Somebody debugging a failed sync is matching them against their own
              logs and their own clock, and a customer's zone is not where that
              happened. */}
          <dl className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
            {field('Quo Lead ID', lead.quoExternalId)}
            {field('Last synced', lead.quoSyncedAt ? formatDateTime(lead.quoSyncedAt) : null)}
            {field('Sync attempts', String(logs.length))}
          </dl>

          {/* Error handling surface */}
          {lead.quoStatus === 'failed' && lead.quoError && (
            <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
              <strong>Quo error:</strong> {lead.quoError}
            </div>
          )}

          {/* Stored response */}
          {lead.quoResponse != null && (
            <div className="mb-4">
              <p className="mb-1 text-xs text-muted-foreground">Stored Quo response</p>
              <pre className="max-h-60 overflow-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(lead.quoResponse, null, 2)}
              </pre>
            </div>
          )}

          {/* Sync history */}
          <div>
            <p className="mb-2 text-xs text-muted-foreground">Sync history</p>
            <div className="space-y-2">
              {logs.length === 0 && <p className="text-sm text-muted-foreground">No attempts yet.</p>}
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-xs"
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full ${log.success ? 'bg-emerald-500' : 'bg-red-500'}`}
                    />
                    {log.success ? 'Success' : 'Failed'}
                    {log.statusCode ? ` · HTTP ${log.statusCode}` : ''}
                    {log.error ? ` · ${log.error}` : ''}
                  </span>
                  <span className="text-muted-foreground">
                    {log.durationMs != null ? `${log.durationMs}ms · ` : ''}
                    {formatTime(log.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Conversation timeline — calls, SMS & notes (Quo / OpenPhone) */}
      <section className="rounded-lg border bg-card p-5">
        <h2 className="mb-4 text-sm font-semibold">Conversation Timeline</h2>
        {timeline.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No communications yet. Calls and SMS sync here automatically via Quo webhooks.
          </p>
        )}
        <div className="space-y-2.5">
          {timeline.map((t) => {
            const inbound = t.direction === 'inbound';
            const tone = t.kind === 'call' ? 'var(--tone-blue-fg)' : t.kind === 'message' ? 'var(--brand)' : 'var(--tone-amber-fg)';
            const label = t.kind === 'call' ? `${inbound ? 'Inbound' : 'Outbound'} call` : t.kind === 'message' ? `${inbound ? 'Inbound' : 'Outbound'} SMS` : 'Note';
            return (
              <div key={`${t.kind}-${t.id}`} className="flex gap-3 rounded-md border px-3 py-2.5">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: tone }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12.5px] font-semibold">
                      {label}
                      {t.status ? <span className="ml-2 font-normal text-muted-foreground">· {t.status}</span> : ''}
                      {typeof t.durationSecs === 'number' ? <span className="ml-2 font-normal text-muted-foreground">· {t.durationSecs}s</span> : ''}
                      {t.by ? <span className="ml-2 font-normal text-muted-foreground">· {t.by}</span> : ''}
                      {t.kind === 'call' && !inbound && t.from ? <span className="ml-2 font-normal text-muted-foreground">· from <span className="font-mono">{t.from}</span></span> : ''}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{leadDateTime(t.at, lead.timezone)}</span>
                  </div>
                  {t.body && <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-foreground">{t.body}</p>}
                  {t.aiSummary && <p className="mt-1 text-[12px] text-muted-foreground"><strong>AI summary:</strong> {t.aiSummary}</p>}
                  {t.transcript && <details className="mt-1 text-[12px] text-muted-foreground"><summary className="cursor-pointer">Transcript</summary><p className="mt-1 whitespace-pre-wrap">{t.transcript}</p></details>}
                  {/* HTTPS only: the URL is stored data, and an arbitrary scheme in an href is a link to anywhere. */}
                  {t.recordingUrl && /^https:\/\//i.test(t.recordingUrl) && <a href={t.recordingUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-[12px] font-medium text-primary hover:underline">▶ Recording</a>}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Follow-Up 1 → 5, in order, with what happened on each. Sits above the
          Zoom timeline: what is owed next is read more often than what has been
          booked. */}
      <FollowupSequence leadId={id} timezone={lead.timezone} />

      {/* Complete Zoom meeting history/timeline for this client */}
      <ZoomTimeline leadId={id} />

      {/* Full audit trail — opened from the Info (ⓘ) action; Admin & Team Lead only */}
      {canSeeActivity && showActivity && (
        <LeadActivityDrawer leadId={id} leadName={lead.businessName} onClose={() => setShowActivity(false)} />
      )}
      {sameDay && (
        <ReassignConfirm
          conflicts={sameDay}
          busy={edit.isPending}
          onConfirm={() => edit.mutate(true)}
          onCancel={() => setSameDay(null)}
        />
      )}
    </div>
  );
}
