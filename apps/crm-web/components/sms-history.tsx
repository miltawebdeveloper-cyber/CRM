'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, RefreshCw, MessageSquare, Check, CheckCheck, Clock, AlertTriangle, Send, Loader2 } from 'lucide-react';
import { communicationsApi, type SmsMessage } from '@/lib/crm';

const LIVE_MS = 15_000;

/** Quo statuses: queued | sent | delivered | undelivered | received (+ our 'failed'). */
function statusStyle(status: string | null) {
  const s = (status ?? '').toLowerCase();
  if (s === 'delivered') return { label: 'Delivered', cls: 'bg-[#d8eed9] text-[#266929]', Icon: CheckCheck };
  if (s === 'sent') return { label: 'Sent', cls: 'bg-[#e7f0f8] text-[#2c5d8f]', Icon: Check };
  if (s === 'queued') return { label: 'Queued', cls: 'bg-[#fbf3e2] text-[#c98a18]', Icon: Clock };
  if (s === 'received') return { label: 'Received', cls: 'bg-muted text-muted-foreground', Icon: Check };
  if (s === 'undelivered' || s === 'failed') return { label: s === 'failed' ? 'Failed' : 'Undelivered', cls: 'bg-[#fbe4e1] text-[#9e2b21]', Icon: AlertTriangle };
  return { label: status ?? 'Unknown', cls: 'bg-muted text-muted-foreground', Icon: Clock };
}

interface Thread {
  key: string;
  leadId: string | null;
  name: string;
  phone: string;
  messages: SmsMessage[];
  lastAt: string;
}

export function SmsHistory({ leadId }: { leadId?: string }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [direction, setDirection] = useState<'' | 'inbound' | 'outbound'>('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [reply, setReply] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data: messages = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['sms', query, direction, status, leadId],
    queryFn: () => communicationsApi.sms({ search: query, direction: direction || undefined, status: status || undefined, leadId }),
    refetchInterval: LIVE_MS, // new SMS appear without a manual refresh
  });
  // Faceted on the same scope as the list (minus status itself), so the counts in
  // the menu describe what's actually on screen.
  const { data: statuses = [] } = useQuery({
    queryKey: ['sms-statuses', query, direction, leadId],
    queryFn: () => communicationsApi.smsStatuses({ search: query, direction: direction || undefined, leadId }),
  });

  // Group the flat list into per-lead conversations, newest thread first.
  const threads = useMemo<Thread[]>(() => {
    const byLead = new Map<string, Thread>();
    for (const m of messages) {
      const key = m.leadId ?? m.conversationId ?? `${m.from}:${m.to}`;
      const existing = byLead.get(key);
      if (existing) {
        existing.messages.push(m);
        if (m.at > existing.lastAt) existing.lastAt = m.at;
      } else {
        byLead.set(key, {
          key,
          leadId: m.leadId,
          name: m.customerName ?? m.businessName ?? (m.direction === 'inbound' ? m.from : m.to),
          phone: m.direction === 'inbound' ? m.from : m.to,
          messages: [m],
          lastAt: m.at,
        });
      }
    }
    return [...byLead.values()]
      .map((t) => ({ ...t, messages: t.messages.sort((a, b) => +new Date(a.at) - +new Date(b.at)) }))
      .sort((a, b) => +new Date(b.lastAt) - +new Date(a.lastAt));
  }, [messages]);

  // Keep a thread open across refetches; default to the most recent one.
  const active = threads.find((t) => t.key === openThread) ?? threads[0];

  /**
   * Reply in-thread. The tab used to be read-only, so answering a customer meant
   * leaving for their lead page. Sending goes through the same endpoint as the
   * lead page, so the reply carries the agent's own caller identity and is
   * attributed to them.
   */
  const send = useMutation({
    // sendSms raises provider-side rejections itself, so a failed send lands on
    // the error toast rather than reporting a message that never went out.
    mutationFn: ({ lead, body }: { lead: string; body: string }) => communicationsApi.sendSms(lead, body),
    meta: { successMessage: 'Message sent' },
    onSuccess: () => {
      setReply('');
      qc.invalidateQueries({ queryKey: ['sms'] });
      qc.invalidateQueries({ queryKey: ['sms-statuses'] });
    },
  });

  const canSend = !!active?.leadId && !!reply.trim() && !send.isPending;
  const submitReply = () => { if (canSend && active?.leadId) send.mutate({ lead: active.leadId, body: reply.trim() }); };

  // Chat panes read bottom-up: jump to the newest message when the thread changes
  // or one arrives, so a reply doesn't land out of sight below the fold.
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [active?.key, active?.messages.length]);

  return (
    <div className="rounded-2xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-[18px] py-4">
        <div>
          <h3 className="font-display text-[15px] font-semibold">SMS</h3>
          <div className="text-xs text-muted-foreground">
            {messages.length} message{messages.length === 1 ? '' : 's'} across {threads.length} conversation{threads.length === 1 ? '' : 's'} · synced from Quo
          </div>
        </div>
        <button onClick={() => refetch()} className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-semibold hover:bg-muted">
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b px-[18px] py-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search message text, customer or number…"
            className="w-full rounded-md border bg-background py-1.5 pl-8 pr-2.5 text-[13px]"
          />
        </div>
        <div className="inline-flex rounded-md bg-muted/60 p-[2px]">
          {([['', 'All'], ['inbound', 'Received'], ['outbound', 'Sent']] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setDirection(k)}
              className={`rounded-[5px] px-2.5 py-[3px] text-[11.5px] font-semibold transition-colors ${direction === k ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="rounded-md border bg-background px-2 py-1.5 text-[12.5px]">
          <option value="">Any status</option>
          {statuses.map((s) => (
            <option key={s.status} value={s.status}>
              {statusStyle(s.status).label} ({s.count})
            </option>
          ))}
        </select>
        {(search || direction || status) && (
          <button onClick={() => { setSearch(''); setDirection(''); setStatus(''); }} className="text-[12px] font-semibold text-muted-foreground hover:text-foreground">
            Clear
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading messages…</p>
      ) : threads.length === 0 ? (
        <div className="py-12 text-center">
          <MessageSquare className="mx-auto mb-2 h-7 w-7 text-muted-foreground/50" />
          <p className="text-sm font-medium">No messages found</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {search || direction || status ? 'No message matches these filters.' : 'SMS appear here once synced from Quo.'}
          </p>
        </div>
      ) : (
        <div className="grid md:grid-cols-[260px_1fr]">
          {/* Conversation list */}
          <div className="max-h-[560px] overflow-y-auto border-b p-2.5 md:border-b-0 md:border-r">
            {threads.map((t) => {
              const last = t.messages[t.messages.length - 1];
              return (
                <button
                  key={t.key}
                  // Drop the draft when switching — a half-typed reply must never
                  // follow you into a different customer's conversation.
                  onClick={() => { setOpenThread(t.key); setReply(''); }}
                  className={`mb-1.5 w-full rounded-[10px] border p-2.5 text-left transition-colors ${active?.key === t.key ? 'border-[#2b732f] bg-muted shadow-[inset_3px_0_0_#266929]' : 'hover:bg-muted/50'}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[13px] font-semibold">{t.name}</span>
                    <span className="shrink-0 text-[10.5px] text-muted-foreground">
                      {new Date(t.lastAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">{t.phone}</div>
                  <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                    {last.direction === 'outbound' ? 'You: ' : ''}{last.body}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Thread */}
          {active && (
            <div className="flex max-h-[560px] flex-col">
              <div className="flex items-center justify-between gap-2 border-b px-[18px] py-2.5">
                <div className="min-w-0">
                  {active.leadId ? (
                    <Link href={`/leads/${active.leadId}`} className="truncate text-[13.5px] font-semibold hover:underline">
                      {active.name}
                    </Link>
                  ) : (
                    <span className="truncate text-[13.5px] font-semibold">{active.name}</span>
                  )}
                  <div className="truncate font-mono text-[11.5px] text-muted-foreground">{active.phone}</div>
                </div>
                {/* Consistency check: a customer should always hear from the SAME line.
                    If outbound messages went out from more than one number, flag it. */}
                {(() => {
                  const froms = [...new Set(active.messages.filter((m) => m.direction === 'outbound').map((m) => m.from))];
                  return froms.length > 1 ? (
                    <span
                      title={`Sent from: ${froms.join(', ')}`}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#fbe4e1] px-2 py-[3px] text-[10.5px] font-semibold text-[#9e2b21]"
                    >
                      <AlertTriangle className="h-3 w-3" /> Sent from {froms.length} numbers
                    </span>
                  ) : (
                    <span className="shrink-0 text-[11.5px] text-muted-foreground">{active.messages.length} messages</span>
                  );
                })()}
              </div>

              <div className="flex-1 space-y-2.5 overflow-y-auto p-[18px]">
                {active.messages.map((m) => {
                  const out = m.direction === 'outbound';
                  const st = statusStyle(m.status);
                  return (
                    <div key={m.id} className={`flex flex-col ${out ? 'items-end' : 'items-start'}`}>
                      <div className={`max-w-[85%] rounded-[14px] px-3 py-2 text-[13px] ${out ? 'rounded-br-[4px] bg-[#2b732f] text-white' : 'rounded-bl-[4px] bg-muted'}`}>
                        {m.body}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted-foreground">
                        {/* Sender → recipient, so it's always clear which way it went. */}
                        <span className="font-mono">{m.from}</span>
                        <span>→</span>
                        <span className="font-mono">{m.to}</span>
                        {out && m.by && <><span>·</span><span>by {m.by}</span></>}
                        <span>·</span>
                        <span>{new Date(m.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                        <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-px font-semibold ${st.cls}`}>
                          <st.Icon className="h-2.5 w-2.5" /> {st.label}
                        </span>
                        {/* Went out from a line that isn't this sender's own caller ID. */}
                        {m.senderMismatch && (
                          <span
                            title={`Sent from ${m.from}, which is not ${m.by ?? 'the sender'}'s assigned caller ID`}
                            className="inline-flex items-center gap-1 rounded-full bg-[#fbe4e1] px-1.5 py-px font-semibold text-[#9e2b21]"
                          >
                            <AlertTriangle className="h-2.5 w-2.5" /> Wrong line
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div ref={endRef} />
              </div>

              {/* Reply composer. Enter sends, Shift+Enter adds a line — the usual
                  chat contract, so replying never needs a trip to the lead page. */}
              <div className="border-t p-3">
                {active.leadId ? (
                  <>
                    <div className="flex items-end gap-2">
                      <textarea
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitReply(); }
                        }}
                        rows={1}
                        placeholder={`Reply to ${active.name}…`}
                        className="max-h-28 min-h-[38px] flex-1 resize-y rounded-lg border bg-background px-3 py-2 text-[13px] outline-none focus:ring-2 focus:ring-primary/30"
                      />
                      <button
                        onClick={submitReply}
                        disabled={!canSend}
                        aria-label="Send message"
                        className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-lg bg-[#2b732f] text-white disabled:opacity-50"
                      >
                        {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      </button>
                    </div>
                    {/* Long messages bill as multiple segments — say so before sending. */}
                    {reply.length > 160 && (
                      <div className="mt-1 text-[10.5px] text-muted-foreground">
                        {reply.length} characters · sends as {Math.ceil(reply.length / 153)} SMS segments
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-[11.5px] text-muted-foreground">
                    This conversation isn’t linked to a lead, so it can’t be replied to from here.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
