/**
 * The ▲/▼ badge on a KPI card: how a figure moved against the period before.
 *
 * Direction and judgement are separate. "Up" is good for calls made and bad
 * for missed calls, so each card says which way is better, and the badge is
 * coloured by the judgement (better / worse / same) — never by direction alone.
 * It always carries the arrow and the number, so it never relies on colour.
 */
export interface KpiDelta {
  /** "12%", "1.5 pts", "new". */
  text: string;
  direction: 'up' | 'down' | 'flat';
  tone: 'better' | 'worse' | 'same';
  /** The full sentence, for the tooltip and screen readers. */
  title: string;
}

export function kpiDelta(
  current: number,
  previous: number,
  opts: { upIsGood?: boolean; kind?: 'pct' | 'pts'; days: number },
): KpiDelta {
  const { upIsGood = true, kind = 'pct', days } = opts;
  const period = `the previous ${days} day${days === 1 ? '' : 's'}`;
  const diff = current - previous;
  const direction: KpiDelta['direction'] = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  const tone: KpiDelta['tone'] = direction === 'flat' ? 'same' : (direction === 'up') === upIsGood ? 'better' : 'worse';

  let text: string;
  if (kind === 'pts') {
    // A rate's change is in percentage points — "2% → 3%" is +1 pt, not +50%.
    text = `${Math.abs(Math.round(diff * 10) / 10)} pts`;
  } else if (previous === 0) {
    // Growth from nothing has no percentage; say what happened instead.
    text = current === 0 ? '0%' : 'new';
  } else {
    text = `${Math.abs(Math.round((diff / previous) * 100))}%`;
  }

  const was = kind === 'pts' ? `${previous}%` : previous.toLocaleString();
  const now = kind === 'pts' ? `${current}%` : current.toLocaleString();
  const moved = direction === 'flat' ? 'unchanged' : direction === 'up' ? `up ${text}` : `down ${text}`;
  return { text, direction, tone, title: `${moved} — ${now} vs ${was} in ${period}` };
}
