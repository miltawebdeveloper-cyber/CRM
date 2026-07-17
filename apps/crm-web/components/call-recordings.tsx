'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Play, Pause, Download, Search, RefreshCw, PhoneIncoming, PhoneOutgoing, Loader2, Mic } from 'lucide-react';
import { communicationsApi, formatDuration, type RecordedCall } from '@/lib/crm';
import { toast } from '@/lib/toast';

const LIVE_MS = 20_000;

/** mm:ss for the player's own clock (formatDuration is for coarse totals). */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function CallRecordings({ leadId }: { leadId?: string }) {
  const [search, setSearch] = useState('');
  const [direction, setDirection] = useState<'' | 'inbound' | 'outbound'>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Debounced so typing doesn't fire a request per keystroke.
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data: calls = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['recordings', query, direction, from, to, leadId],
    queryFn: () => communicationsApi.recordings({ search: query, direction: direction || undefined, from, to, leadId }),
    refetchInterval: LIVE_MS,
  });

  // One <audio> for the whole list: playing a second recording replaces the
  // first, so two recordings can never talk over each other.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const urlCache = useRef(new Map<string, string>());

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
    const hit = urlCache.current.get(recordingId);
    if (hit) return hit;
    const url = await communicationsApi.recordingAudioUrl(recordingId);
    urlCache.current.set(recordingId, url);
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
          <h3 className="font-display text-[15px] font-semibold">Call Recordings</h3>
          <div className="text-xs text-muted-foreground">
            {totalRecordings} recording{totalRecordings === 1 ? '' : 's'} across {calls.length} call{calls.length === 1 ? '' : 's'} · synced from Quo
          </div>
        </div>
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-semibold hover:bg-muted"
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
            placeholder="Search customer, number or agent…"
            className="w-full rounded-md border bg-background py-1.5 pl-8 pr-2.5 text-[13px]"
          />
        </div>
        <div className="inline-flex rounded-md bg-muted/60 p-[2px]">
          {([['', 'All'], ['inbound', 'Inbound'], ['outbound', 'Outbound']] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setDirection(k)}
              className={`rounded-[5px] px-2.5 py-[3px] text-[11.5px] font-semibold transition-colors ${direction === k ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" className="rounded-md border bg-background px-2 py-1.5 text-[12.5px]" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" className="rounded-md border bg-background px-2 py-1.5 text-[12.5px]" />
        {(search || direction || from || to) && (
          <button
            onClick={() => { setSearch(''); setDirection(''); setFrom(''); setTo(''); }}
            className="text-[12px] font-semibold text-muted-foreground hover:text-foreground"
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
            />
          ))
        )}
      </div>
    </div>
  );
}

function RecordingRow({
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
  const Icon = call.direction === 'inbound' ? PhoneIncoming : PhoneOutgoing;

  return (
    <div className="mb-[9px] rounded-[11px] border p-3 hover:bg-muted/40">
      <div className="flex flex-wrap items-center gap-3">
        <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-[9px] ${call.direction === 'inbound' ? 'bg-[#e7f0f8] text-[#2c5d8f]' : 'bg-[#d8eed9] text-[#266929]'}`}>
          <Icon className="h-[18px] w-[18px]" />
        </div>

        <div className="min-w-0 flex-1">
          <Link href={`/leads/${call.leadId}`} className="truncate text-[13px] font-semibold hover:underline">
            {call.customerName}
          </Link>
          <div className="truncate font-mono text-[11.5px] text-muted-foreground">{call.phone}</div>
        </div>

        <div className="hidden text-right sm:block">
          <div className="text-[12.5px] font-medium">{when.toLocaleDateString()}</div>
          <div className="text-[11.5px] text-muted-foreground">{when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        </div>

        <div className="w-[64px] text-right font-mono text-[12.5px]">{formatDuration(call.durationSecs ?? 0)}</div>

        {call.by && <div className="hidden w-[110px] truncate text-[11.5px] text-muted-foreground md:block">by {call.by}</div>}
      </div>

      {/* One control row per segment — a call can be recorded in several parts. */}
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
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#2b732f] text-white disabled:opacity-60"
              >
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : isPlaying ? <Pause className="h-4 w-4" /> : <Play className="ml-[2px] h-4 w-4" />}
              </button>

              {call.recordings.length > 1 && (
                <span className="shrink-0 text-[11px] font-semibold text-muted-foreground">Part {i + 1}</span>
              )}

              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
                <div className="h-full rounded-full bg-[#2b732f] transition-[width]" style={{ width: `${pct}%` }} />
              </div>

              <span className="w-[72px] shrink-0 text-right font-mono text-[11.5px] text-muted-foreground">
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
    </div>
  );
}
