'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Play, Pause, Download, Search, RefreshCw, PhoneIncoming, PhoneOutgoing, Loader2, Mic,
  AlertTriangle, Sparkles, FileText, X, RotateCw, Headphones,
} from 'lucide-react';
import { communicationsApi, formatDuration, type RecordedCall, type CallInsight, type CallSummary } from '@/lib/crm';
import { api } from '@/lib/api';
import { DateFilter } from '@/components/filter-controls';
import { EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { toast } from '@/lib/toast';
import { formatDate, formatDateTime, formatTime } from '@/lib/display-settings';

const LIVE_MS = 20_000;

/**
 * How many decoded recordings to keep as object URLs. Each one pins a whole
 * audio blob in memory, so an unbounded cache grows for as long as the tab is
 * open; a handful is enough to make re-playing a recent recording instant.
 */
const MAX_CACHED_AUDIO = 5;

/** mm:ss for the player's own clock (formatDuration is for coarse totals). */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

type InsightTab = 'summary' | 'transcript' | 'recording';

export function CallRecordings({ leadId }: { leadId?: string }) {
  const [search, setSearch] = useState('');
  const [direction, setDirection] = useState<'' | 'inbound' | 'outbound'>('');
  // Same calendar filter as Calls Made — the mode resolves to plain from/to
  // bounds, which is exactly what the recordings endpoint already expects.
  const [dateFilter, setDateFilter] = useState<DateFilterValue>(EMPTY_DATE_FILTER);
  const { from, to } = dateFilter;
  // Debounced so typing doesn't fire a request per keystroke.
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // One <audio> for the whole list: playing a second recording replaces the
  // first, so two recordings can never talk over each other.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  // Which call's AI insight is open, and which tab it opened on.
  const [insight, setInsight] = useState<{ call: RecordedCall; tab: InsightTab } | null>(null);

  const { data: calls = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['recordings', query, direction, from, to, leadId],
    queryFn: () => communicationsApi.recordings({ search: query, direction: direction || undefined, from, to, leadId }),
    // Pause the live poll during playback: a refetch can reorder the list under
    // the row you're listening to. Resumes as soon as playback stops.
    refetchInterval: playing ? false : LIVE_MS,
  });
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const urlCache = useRef(new Map<string, string>());

  // Who's viewing — an admin kicks a one-time backfill so existing recordings
  // fill in their AI summaries; everyone else just reads what's there.
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });
  const backfilled = useRef(false);
  useEffect(() => {
    if (me?.role === 'admin' && !backfilled.current) {
      backfilled.current = true;
      communicationsApi.backfillInsights().catch(() => {});
    }
  }, [me]);

  // Blob URLs are per-document; release them when the tab unmounts.
  useEffect(() => {
    const cache = urlCache.current;
    const audio = audioRef.current;
    return () => {
      audio?.pause();
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, []);

  async function blobUrl(recordingId: string) {
    const cache = urlCache.current;
    const hit = cache.get(recordingId);
    if (hit) {
      // Re-insert so recently played entries are the last to be evicted.
      cache.delete(recordingId);
      cache.set(recordingId, hit);
      return hit;
    }
    const url = await communicationsApi.recordingAudioUrl(recordingId);
    cache.set(recordingId, url);

    // Evict oldest-first, releasing the blob each entry holds. Compare against the
    // <audio> element's own src rather than React state — this runs in an async
    // callback, so state here could be stale and we'd revoke what's playing.
    for (const [id, u] of [...cache.entries()]) {
      if (cache.size <= MAX_CACHED_AUDIO) break;
      if (u === audioRef.current?.src) continue;
      URL.revokeObjectURL(u);
      cache.delete(id);
    }
    return url;
  }

  async function toggle(recordingId: string) {
    const el = audioRef.current;
    if (!el) return;
    if (playing === recordingId) {
      el.pause();
      setPlaying(null);
      return;
    }
    setLoadingId(recordingId);
    try {
      const url = await blobUrl(recordingId);
      el.src = url;
      await el.play();
      setPlaying(recordingId);
    } catch {
      toast.error('Could not play this recording. It may no longer be available from Quo.');
      setPlaying(null);
    } finally {
      setLoadingId(null);
    }
  }

  async function download(recordingId: string, name: string, mimeType: string | null) {
    try {
      const url = await communicationsApi.recordingAudioUrl(recordingId, true);
      const a = document.createElement('a');
      a.href = url;
      // Match the extension to what the segment actually is — Quo serves mp3,
      // but sandbox recordings are wav, and a mislabelled file won't open.
      const ext = mimeType?.includes('wav') ? 'wav' : mimeType?.includes('ogg') ? 'ogg' : 'mp3';
      a.download = `${name.replace(/[^\w.-]+/g, '_')}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Not cached: this URL carries attachment disposition, unlike the player's.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast.error('Could not download this recording.');
    }
  }

  const totalRecordings = calls.reduce((a, c) => a + c.recordings.length, 0);

  return (
    <div className="rounded-2xl border bg-card shadow-sm">
      <audio
        ref={audioRef}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onEnded={() => { setPlaying(null); setPos(0); }}
        className="hidden"
      />

      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-[18px] py-4">
        <div>
          <h3 className="font-display text-[14px] font-semibold">Call Recordings</h3>
          <div className="text-xs text-muted-foreground">
            {totalRecordings} recording{totalRecordings === 1 ? '' : 's'} across {calls.length} call{calls.length === 1 ? '' : 's'} · AI summary &amp; transcript from Quo
          </div>
        </div>
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11.5px] font-semibold hover:bg-muted"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 border-b px-[18px] py-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customer, number, agent, summary or transcript…"
            className="w-full rounded-md border bg-background py-1.5 pl-8 pr-2.5 text-[12.5px]"
          />
        </div>
        <div className="inline-flex rounded-md bg-muted/60 p-[2px]">
          {([['', 'All'], ['inbound', 'Inbound'], ['outbound', 'Outbound']] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setDirection(k)}
              className={`rounded-[5px] px-2.5 py-[3px] text-[11px] font-semibold transition-colors ${direction === k ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {/* Same Day/Week/Month/Year/Custom calendar the rest of the CRM uses. */}
        <DateFilter value={dateFilter} onChange={setDateFilter} />
        {(search || direction || from || to) && (
          <button
            onClick={() => { setSearch(''); setDirection(''); setDateFilter(EMPTY_DATE_FILTER); }}
            className="text-[11.5px] font-semibold text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>

      <div className="max-h-[620px] overflow-y-auto p-[14px]">
        {isLoading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading recordings…</p>
        ) : calls.length === 0 ? (
          <div className="py-12 text-center">
            <Mic className="mx-auto mb-2 h-7 w-7 text-muted-foreground/50" />
            <p className="text-sm font-medium">No recordings found</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {search || direction || from || to
                ? 'No recording matches these filters.'
                : 'Recordings appear here once calls are synced from Quo.'}
            </p>
          </div>
        ) : (
          calls.map((c) => (
            <RecordingRow
              key={c.callId}
              call={c}
              playing={playing}
              loadingId={loadingId}
              pos={pos}
              dur={dur}
              onToggle={toggle}
              onDownload={download}
              onOpenInsight={(tab) => setInsight({ call: c, tab })}
            />
          ))
        )}
      </div>

      {insight && (
        <InsightModal
          call={insight.call}
          initialTab={insight.tab}
          query={query}
          onClose={() => setInsight(null)}
          playing={playing}
          loadingId={loadingId}
          pos={pos}
          dur={dur}
          onToggle={toggle}
          onDownload={download}
        />
      )}
    </div>
  );
}

/** Small coloured dot describing a call's AI insight state. */
function InsightDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    ready: 'bg-[var(--brand-mid)]',
    processing: 'bg-[var(--tone-amber-fg)] animate-pulse',
    pending: 'bg-[var(--tone-amber-fg)] animate-pulse',
    failed: 'bg-[var(--tone-red-fg)]',
    unavailable: 'bg-muted-foreground/40',
  };
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${map[status] ?? 'bg-muted-foreground/40'}`} />;
}

function RecordingRow({
  call, playing, loadingId, pos, dur, onToggle, onDownload, onOpenInsight,
}: {
  call: RecordedCall;
  playing: string | null;
  loadingId: string | null;
  pos: number;
  dur: number;
  onToggle: (id: string) => void;
  onDownload: (id: string, name: string, mimeType: string | null) => void;
  onOpenInsight: (tab: InsightTab) => void;
}) {
  const when = new Date(call.at);
  const Icon = call.direction === 'inbound' ? PhoneIncoming : PhoneOutgoing;
  const status = call.insight?.status ?? 'none';

  return (
    <div className="mb-[9px] rounded-[11px] border p-3 hover:bg-muted/40">
      <div className="flex flex-wrap items-center gap-3">
        <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-[9px] ${call.direction === 'inbound' ? 'bg-[var(--tone-blue-bg)] text-[var(--tone-blue-fg)]' : 'bg-[var(--brand-surface)] text-[var(--brand-on-surface)]'}`}>
          <Icon className="h-[18px] w-[18px]" />
        </div>

        <div className="min-w-0 flex-1">
          {/* A recording from an unknown number has no lead to open — the name is
              plain text rather than a link to `/leads/null`. */}
          {call.leadId ? (
            <Link href={`/leads/${call.leadId}`} className="truncate text-[12.5px] font-semibold hover:underline">
              {call.customerName}
            </Link>
          ) : (
            <div className="truncate text-[12.5px] font-semibold">{call.customerName}</div>
          )}
          <div className="truncate font-mono text-[11px] text-muted-foreground">{call.phone}</div>
          {/* Caller identity the customer saw. Outbound calls with no recorded line
              predate identity tracking — flag them so a manager can verify who called. */}
          {call.direction === 'outbound' && (
            call.from ? (
              <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">Caller ID <span className="font-mono text-foreground">{call.from}</span></div>
            ) : (
              <div className="mt-0.5 inline-flex items-center gap-1 text-[10.5px] font-medium text-[var(--tone-red-fg-2)]">
                <AlertTriangle className="h-3 w-3" /> Caller ID not recorded
              </div>
            )
          )}
        </div>

        <div className="hidden text-right sm:block">
          <div className="text-[12px] font-medium">{formatDate(when)}</div>
          <div className="text-[11px] text-muted-foreground">{formatTime(when)}</div>
        </div>

        <div className="w-[64px] text-right font-mono text-[12px]">{formatDuration(call.durationSecs ?? 0)}</div>

        {call.by && <div className="hidden w-[110px] truncate text-[11px] text-muted-foreground md:block">by {call.by}</div>}
      </div>

      {/* Call-level AI actions — the summary and transcript describe the whole call,
          not an individual segment, so they live here above the per-segment players. */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={() => onOpenInsight('summary')}
          className="inline-flex items-center gap-1.5 rounded-md border border-[#c9b8e6] bg-[#f6f2fc] px-2.5 py-1.5 text-[11px] font-semibold text-[#5b3d99] hover:bg-[#efe7fa]"
        >
          <Sparkles className="h-3.5 w-3.5" /> AI Summary <InsightDot status={status} />
        </button>
        <button
          onClick={() => onOpenInsight('transcript')}
          className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <FileText className="h-3.5 w-3.5" /> View Transcript
        </button>
      </div>

      {/* One control row per segment — a call can be recorded in several parts. */}
      <SegmentControls call={call} playing={playing} loadingId={loadingId} pos={pos} dur={dur} onToggle={onToggle} onDownload={onDownload} />
    </div>
  );
}

/** The play/scrub/download rows for a call's recording segments — reused by the
 *  list and by the insight modal's Recording tab. */
function SegmentControls({
  call, playing, loadingId, pos, dur, onToggle, onDownload,
}: {
  call: RecordedCall;
  playing: string | null;
  loadingId: string | null;
  pos: number;
  dur: number;
  onToggle: (id: string) => void;
  onDownload: (id: string, name: string, mimeType: string | null) => void;
}) {
  const when = new Date(call.at);
  return (
    <div className="mt-2 space-y-1.5">
      {call.recordings.map((r, i) => {
        const isPlaying = playing === r.id;
        const isLoading = loadingId === r.id;
        const segDur = isPlaying && dur ? dur : r.durationSecs ?? 0;
        const pct = isPlaying && segDur ? Math.min(100, (pos / segDur) * 100) : 0;
        return (
          <div key={r.id} className="flex items-center gap-2.5 rounded-[9px] bg-muted/50 px-2.5 py-1.5">
            <button
              onClick={() => onToggle(r.id)}
              disabled={isLoading}
              aria-label={isPlaying ? 'Pause recording' : 'Play recording'}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--brand-mid)] text-white disabled:opacity-60"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : isPlaying ? <Pause className="h-4 w-4" /> : <Play className="ml-[2px] h-4 w-4" />}
            </button>

            {call.recordings.length > 1 && (
              <span className="shrink-0 text-[10.5px] font-semibold text-muted-foreground">Part {i + 1}</span>
            )}

            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
              <div className="h-full rounded-full bg-[var(--brand-mid)] transition-[width]" style={{ width: `${pct}%` }} />
            </div>

            <span className="w-[72px] shrink-0 text-right font-mono text-[11px] text-muted-foreground">
              {isPlaying ? `${clock(pos)} / ${clock(segDur)}` : clock(r.durationSecs ?? 0)}
            </span>

            <button
              onClick={() => onDownload(r.id, `${call.customerName}_${when.toISOString().slice(0, 10)}`, r.mimeType)}
              aria-label="Download recording"
              title="Download"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md border hover:bg-background"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Insight modal ──

const SUMMARY_SECTIONS: { key: keyof CallSummary; label: string }[] = [
  { key: 'purpose', label: 'Purpose of the call' },
  { key: 'keyPoints', label: 'Key discussion points' },
  { key: 'customerRequirements', label: 'Customer requirements' },
  { key: 'questionsAsked', label: 'Questions asked by the customer' },
  { key: 'employeeResponses', label: 'Responses provided by the employee' },
  { key: 'decisions', label: 'Decisions made' },
  { key: 'followUps', label: 'Follow-up actions' },
  { key: 'outcome', label: 'Overall call outcome' },
  { key: 'nextSteps', label: 'Suggested next steps' },
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Render text with any occurrences of `term` highlighted. */
function Highlight({ text, term }: { text: string; term: string }) {
  if (!term.trim()) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(term.trim())})`, 'ig'));
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === term.trim().toLowerCase()
          ? <mark key={i} className="rounded bg-[#fff2ad] px-0.5 text-foreground">{p}</mark>
          : <span key={i}>{p}</span>,
      )}
    </>
  );
}

function InsightModal({
  call, initialTab, query, onClose, playing, loadingId, pos, dur, onToggle, onDownload,
}: {
  call: RecordedCall;
  initialTab: InsightTab;
  query: string;
  onClose: () => void;
  playing: string | null;
  loadingId: string | null;
  pos: number;
  dur: number;
  onToggle: (id: string) => void;
  onDownload: (id: string, name: string, mimeType: string | null) => void;
}) {
  const [tab, setTab] = useState<InsightTab>(initialTab);
  const when = new Date(call.at);

  const { data, isLoading, refetch, isRefetching } = useQuery<CallInsight>({
    queryKey: ['insight', call.callId],
    queryFn: () => communicationsApi.callInsight(call.callId),
    // Poll while a summary is still being generated so the modal fills in live.
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'pending' || s === 'processing' ? 3000 : false;
    },
  });

  const [regenerating, setRegenerating] = useState(false);
  async function regenerate() {
    setRegenerating(true);
    try {
      await communicationsApi.regenerateInsight(call.callId);
      await refetch();
    } catch {
      toast.error('Could not start generation.');
    } finally {
      setRegenerating(false);
    }
  }

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const status = data?.status ?? call.insight?.status ?? 'none';
  const generating = status === 'pending' || status === 'processing';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <div className="truncate font-display text-[14px] font-semibold">{call.customerName}</div>
            <div className="truncate text-xs text-muted-foreground">
              {formatDate(when)} · {formatTime(when)} · {formatDuration(call.durationSecs ?? 0)}
              {call.by ? ` · by ${call.by}` : ''}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 shrink-0 place-items-center rounded-md border hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b px-4 pt-2">
          {([['summary', 'AI Summary', Sparkles], ['transcript', 'Transcript', FileText], ['recording', 'Recording', Headphones]] as const).map(([k, label, TabIcon]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`inline-flex items-center gap-1.5 rounded-t-md px-3 py-2 text-[12px] font-semibold transition-colors ${tab === k ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <TabIcon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="min-h-[220px] flex-1 overflow-y-auto px-5 py-4">
          {tab === 'recording' ? (
            <div>
              <p className="mb-2 text-xs text-muted-foreground">The original recording is preserved — AI insights are generated separately.</p>
              <SegmentControls call={call} playing={playing} loadingId={loadingId} pos={pos} dur={dur} onToggle={onToggle} onDownload={onDownload} />
            </div>
          ) : isLoading ? (
            <div className="grid place-items-center py-14 text-sm text-muted-foreground">
              <Loader2 className="mb-2 h-5 w-5 animate-spin" /> Loading…
            </div>
          ) : generating ? (
            <div className="grid place-items-center py-14 text-center text-sm text-muted-foreground">
              <Loader2 className="mb-2 h-5 w-5 animate-spin text-[#5b3d99]" />
              Generating AI {tab === 'transcript' ? 'transcript' : 'summary'}…
              <span className="mt-1 text-xs">This runs automatically after a call is synced.</span>
            </div>
          ) : status === 'none' || status === 'failed' ? (
            <div className="grid place-items-center py-14 text-center text-sm">
              <Sparkles className="mb-2 h-6 w-6 text-muted-foreground/50" />
              <p className="font-medium">{status === 'failed' ? 'Generation failed' : 'No AI insight yet'}</p>
              {data?.error && <p className="mt-1 max-w-sm text-xs text-muted-foreground">{data.error}</p>}
              <button
                onClick={regenerate}
                disabled={regenerating}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-60"
              >
                {regenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Generate now
              </button>
            </div>
          ) : status === 'unavailable' ? (
            <div className="grid place-items-center py-14 text-center text-sm text-muted-foreground">
              <FileText className="mb-2 h-6 w-6 text-muted-foreground/50" />
              No transcript was available for this call, so no summary could be produced.
            </div>
          ) : tab === 'summary' ? (
            <SummaryView summary={data?.summary ?? null} term={query} />
          ) : (
            <TranscriptView insight={data ?? null} term={query} />
          )}
        </div>

        {/* Footer */}
        {status === 'ready' && (
          <div className="flex items-center justify-between gap-3 border-t px-5 py-3 text-[10.5px] text-muted-foreground">
            <span>
              {data?.model === 'heuristic' ? 'Generated automatically (no AI model configured)' : `AI-generated${data?.model ? ` · ${data.model}` : ''}`}
              {data?.generatedAt ? ` · ${formatDateTime(data.generatedAt)}` : ''}
            </span>
            <button
              onClick={regenerate}
              disabled={regenerating || isRefetching}
              className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-semibold text-foreground hover:bg-muted disabled:opacity-60"
            >
              <RotateCw className={`h-3.5 w-3.5 ${regenerating ? 'animate-spin' : ''}`} /> Regenerate
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryView({ summary, term }: { summary: CallSummary | null; term: string }) {
  if (!summary) return <p className="py-10 text-center text-sm text-muted-foreground">No summary content.</p>;
  return (
    <div className="space-y-3">
      {SUMMARY_SECTIONS.map(({ key, label }) => {
        const value = summary[key];
        const items = Array.isArray(value) ? value : value ? [value] : [];
        return (
          <div key={key} className="rounded-[11px] border bg-muted/30 p-3">
            <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-[.06em] text-[#5b3d99]">{label}</div>
            {items.length === 0 ? (
              <p className="text-[12px] italic text-muted-foreground">None noted.</p>
            ) : Array.isArray(value) ? (
              <ul className="space-y-1">
                {items.map((it, i) => (
                  <li key={i} className="flex gap-2 text-[12px] leading-relaxed">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[#5b3d99]" />
                    <span><Highlight text={it} term={term} /></span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] leading-relaxed"><Highlight text={items[0]} term={term} /></p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TranscriptView({ insight, term }: { insight: CallInsight | null; term: string }) {
  const turns = insight?.transcript ?? [];
  if (turns.length === 0) return <p className="py-10 text-center text-sm text-muted-foreground">No transcript content.</p>;
  const stamp = (s: number | null) => (s == null ? '' : clock(s));
  return (
    <div className="space-y-2.5">
      {turns.map((t, i) => {
        const isEmp = t.speaker === 'employee';
        return (
          <div key={i} className={`flex ${isEmp ? 'justify-start' : 'justify-end'}`}>
            <div className={`max-w-[85%] rounded-[12px] px-3 py-2 ${isEmp ? 'bg-[var(--tone-blue-bg)]' : 'bg-[var(--brand-surface)]'}`}>
              <div className="mb-0.5 flex items-center gap-2">
                <span className={`text-[10.5px] font-bold ${isEmp ? 'text-[var(--tone-blue-fg)]' : 'text-[var(--brand)]'}`}>
                  {isEmp ? 'Employee' : 'Customer'}{t.speakerName ? ` · ${t.speakerName}` : ''}
                </span>
                {t.startSecs != null && <span className="font-mono text-[10px] text-muted-foreground">{stamp(t.startSecs)}</span>}
              </div>
              <p className="text-[12px] leading-relaxed text-foreground"><Highlight text={t.text} term={term} /></p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
