'use client';

import { useState } from 'react';
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
  return { fill: '#d8e8d9', text: 'var(--brand)' };
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

export default function TerritoriesPage() {
  const { data: states = [] } = useQuery<StateMetric[]>({
    queryKey: ['m-states'],
    queryFn: () => metricsApi.byState(),
    refetchInterval: LIVE_MS,
    refetchOnWindowFocus: true,
  });
  const byName = new Map(states.map((s) => [s.state, s]));
  const [selected, setSelected] = useState<StateShape | null>(null);

  const metric = selected ? (byName.get(selected.name) ?? EMPTY(selected.name)) : null;

  // Anchor the panel beside the state rather than on top of it, flipping to the
  // left for eastern states so it never covers them or the Northeast callouts.
  const px = selected ? (selected.lx / W) * 100 : 0;
  const py = selected ? Math.min(Math.max((selected.ly / H) * 100, 12), 88) : 0;
  const flipLeft = selected ? selected.lx > W * 0.58 : false;

  function renderState(s: StateShape) {
    const m = byName.get(s.name);
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
        <div className="text-xs text-muted-foreground">
          {states.length} states with leads · {states.reduce((a, s) => a + s.total, 0).toLocaleString()} total ·
          {' '}Select a state for its lead stats
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] bg-white ring-1 ring-[var(--brand-line)]" /> none</span>
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] bg-[#d8e8d9]" /> low</span>
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
              <span className="font-display text-[12.5px] font-bold leading-tight">
                {metric.state} ({selected.ab})
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
