'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { metricsApi, type StateMetric } from '@/lib/crm';
import { US_STATES, US_MAP_WIDTH as W, US_MAP_HEIGHT as H, type StateShape } from '@/lib/us-states-geo';

// Keep the map in step with Lead Management without a manual refresh.
const LIVE_MS = 15_000;

// Northeast states too small (or too tightly packed) to hold a label — DC and MD
// centroids sit ~4px apart. These get a leader line out to a stacked label in the
// gutter the projection reserves on the right.
const CALLOUT_Y: Record<string, number> = {
  VT: 150, NH: 172, MA: 194, RI: 216, CT: 238, NJ: 260, DE: 282, MD: 304, DC: 326,
};
const LEADER_X = 838;
const CALLOUT_X = 846;

// Choropleth buckets by total leads — mirrored by the legend below the header.
function fillFor(total: number): { fill: string; text: string } {
  if (total === 0) return { fill: '#ffffff', text: '#5b6b5c' };
  if (total >= 60) return { fill: 'var(--brand-mid)', text: '#ffffff' };
  if (total >= 25) return { fill: 'var(--brand-lime)', text: 'var(--brand-ink-2)' };
  return { fill: 'var(--brand-edge)', text: 'var(--brand)' };
}

/** Metrics for a state with no leads yet — every state stays clickable. */
const EMPTY = (state: string): StateMetric => ({
  state,
  timezone: '',
  total: 0,
  assigned: 0,
  contacted: 0,
  planned: 0,
  balance: 0,
  progressPct: 0,
});

/**
 * Resolve whatever a lead calls its state to the shape on the map.
 *
 * Leads store the USPS abbreviation — every one of them, "FL" and "GA", not
 * "Florida". The map was joining on the full name, so nothing ever matched: the
 * whole country rendered in the zero-leads colour and every state opened a panel
 * of zeroes, on a page whose caption sat above it correctly reporting hundreds
 * of leads across dozens of states.
 *
 * Both forms are accepted rather than swapping one hard-coded assumption for the
 * other. Imports are the source of this field and they don't agree with each
 * other — an export written in full names is not a broken import, and it must
 * not be a blank map either.
 */
const norm = (v: string) => v.trim().toLowerCase();
const AB_BY_KEY = new Map<string, string>(
  US_STATES.flatMap((s) => [
    [norm(s.ab), s.ab],
    [norm(s.name), s.ab],
  ] as [string, string][]),
);

/** Add a metric row into the running total for its state. */
function mergeMetric(into: StateMetric, row: StateMetric): StateMetric {
  const total = into.total + row.total;
  const planned = into.planned + row.planned;
  return {
    ...into,
    // Keep whichever zone is known; a state sits in one, and "" means unset.
    timezone: into.timezone || row.timezone,
    total,
    assigned: into.assigned + row.assigned,
    contacted: into.contacted + row.contacted,
    planned,
    // Recomputed rather than summed — a balance and a percentage are not
    // additive, and adding two of them is how a merged state reports 190%.
    balance: Math.max(planned - total, 0),
    progressPct: planned > 0 ? Number(((total / planned) * 100).toFixed(1)) : 0,
  };
}

export default function TerritoriesPage() {
  const { data: states = [] } = useQuery<StateMetric[]>({
    queryKey: ['m-states'],
    queryFn: () => metricsApi.byState(),
    refetchInterval: LIVE_MS,
    refetchOnWindowFocus: true,
  });
  // Keyed by abbreviation, which is the one form every shape on the map has.
  // Rows that resolve to the same state are merged rather than overwriting each
  // other, so a book holding both "FL" and "Florida" reports one Florida with
  // all of its leads instead of whichever row the API happened to return last.
  const { byState, unmappedLeads } = useMemo(() => {
    const map = new Map<string, StateMetric>();
    let unmapped = 0;
    for (const row of states) {
      const ab = AB_BY_KEY.get(norm(row.state));
      // "Unknown", territories and anything the projection doesn't draw. Counted
      // rather than dropped: leads with no usable state are invisible on a map
      // by nature, and a caption that quietly omitted them would have the page
      // disagreeing with Lead Management about how many leads exist.
      if (!ab) {
        unmapped += row.total;
        continue;
      }
      const prev = map.get(ab);
      map.set(ab, prev ? mergeMetric(prev, row) : { ...row, state: ab });
    }
    return { byState: map, unmappedLeads: unmapped };
  }, [states]);
  const [selected, setSelected] = useState<StateShape | null>(null);

  const metric = selected ? (byState.get(selected.ab) ?? EMPTY(selected.ab)) : null;

  // Anchor the panel beside the state rather than on top of it, flipping to the
  // left for eastern states so it never covers them or the Northeast callouts.
  const px = selected ? (selected.lx / W) * 100 : 0;
  const py = selected ? Math.min(Math.max((selected.ly / H) * 100, 12), 88) : 0;
  const flipLeft = selected ? selected.lx > W * 0.58 : false;

  function renderState(s: StateShape) {
    const m = byState.get(s.ab);
    const { fill, text } = fillFor(m?.total ?? 0);
    const isSelected = selected?.ab === s.ab;
    const callout = CALLOUT_Y[s.ab];
    return (
      <g
        key={s.ab}
        role="button"
        tabIndex={0}
        aria-label={`${s.name}: ${m?.total ?? 0} leads`}
        aria-pressed={isSelected}
        className="cursor-pointer outline-none focus-visible:opacity-80"
        onClick={() => setSelected(isSelected ? null : s)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setSelected(isSelected ? null : s);
          }
        }}
      >
        <path
          d={s.d}
          fill={fill}
          stroke={isSelected ? '#14140f' : 'var(--brand-line)'}
          strokeWidth={isSelected ? 2.5 : 0.75}
          strokeLinejoin="round"
          className="transition-[fill,stroke] hover:brightness-95"
        />
        {callout ? (
          <>
            <line
              x1={s.lx}
              y1={s.ly}
              x2={LEADER_X}
              y2={callout}
              stroke={isSelected ? '#14140f' : '#9db69e'}
              strokeWidth={isSelected ? 1.5 : 0.75}
            />
            <circle cx={s.lx} cy={s.ly} r={1.5} fill={isSelected ? '#14140f' : '#9db69e'} />
            <text
              x={CALLOUT_X}
              y={callout + 4}
              textAnchor="start"
              fontSize={11}
              fontWeight={600}
              fontFamily="var(--font-mono)"
              fill={isSelected ? '#14140f' : '#4a5a4b'}
              className="select-none"
            >
              {s.ab}
            </text>
          </>
        ) : (
          <text
            x={s.lx}
            y={s.ly + 4}
            textAnchor="middle"
            fontSize={11}
            fontWeight={600}
            fontFamily="var(--font-mono)"
            fill={isSelected ? '#14140f' : text}
            className="pointer-events-none select-none"
          >
            {s.ab}
          </text>
        )}
      </g>
    );
  }

  const unselected = US_STATES.filter((s) => s.ab !== selected?.ab);
  const selectedShape = US_STATES.find((s) => s.ab === selected?.ab);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        {/* Counts the states actually DRAWN, so the caption describes the map
            under it. Leads whose state the map can't place are named separately
            rather than folded in — they're real leads, and silently leaving them
            out of the total is how this page and Lead Management end up
            disagreeing about the size of the book. */}
        <div className="text-xs text-muted-foreground">
          {byState.size} states with leads · {states.reduce((a, s) => a + s.total, 0).toLocaleString()} total
          {unmappedLeads > 0 && ` (${unmappedLeads.toLocaleString()} with no mapped state)`} ·
          {' '}Select a state for its lead stats
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] bg-white ring-1 ring-[var(--brand-edge)]" /> none</span>
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] bg-[var(--brand-edge)]" /> low</span>
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] bg-[var(--brand-lime)]" /> medium</span>
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] bg-[var(--brand-mid)]" /> high</span>
        </div>
      </div>

      {/* Cap the width so the map's height (width / aspect) always fits the space
          left by the topbar, page padding and the caption above — the map scales
          down to stay fully visible rather than pushing the page into a scroll. */}
      <div className="relative mx-auto w-full max-w-[calc((100dvh-160px)*1.6)]">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          className="block h-auto w-full"
          // A click on the ocean clears the selection.
          onClick={(e) => { if (e.target === e.currentTarget) setSelected(null); }}
        >
          <rect width={W} height={H} fill="transparent" />
          {unselected.map(renderState)}
          {/* Drawn last so its highlight stroke is never clipped by a neighbour. */}
          {selectedShape && renderState(selectedShape)}
        </svg>

        {selected && metric && (
          <div
            className="absolute z-10 w-[190px] max-w-[calc(100%-36px)] rounded-[10px] bg-[#14140f] px-3 py-2.5 text-[11.5px] text-white shadow-lg"
            style={{
              left: `${px}%`,
              top: `${py}%`,
              transform: `translate(${flipLeft ? 'calc(-100% - 14px)' : '14px'}, -50%)`,
            }}
          >
            <div className="mb-1.5 flex items-start justify-between gap-2">
              {/* Titled from the SHAPE, not the metric: the metric now carries
                  the abbreviation, and "FL (FL)" tells nobody anything. */}
              <span className="font-display text-[12.5px] font-bold leading-tight">
                {selected.name} ({selected.ab})
              </span>
              <button
                type="button"
                aria-label="Close"
                className="-mr-1 -mt-0.5 px-1 text-[13px] leading-none text-white/50 hover:text-white"
                onClick={() => setSelected(null)}
              >
                ×
              </button>
            </div>
            {([
              ['Total Leads', metric.total],
              ['Assigned Leads', metric.assigned],
              ['Contacted', metric.contacted],
            ] as const).map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 py-px">
                <span className="text-[var(--brand-lime)]">{label}</span>
                <span className="font-mono">{value.toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
