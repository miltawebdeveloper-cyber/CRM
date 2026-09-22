'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarRange, ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { DateRange, DateFilterValue, DateMode } from '@/lib/date-filters';

// ── date helpers (local-time, no UTC drift) ──
const pad = (n: number) => String(n).padStart(2, '0');
export const toISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const fmt = (s: string) => parseISO(s).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
const fmtShort = (s: string) => parseISO(s).toLocaleDateString([], { month: 'short', day: 'numeric' });
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/** Hook: close when clicking/escaping outside the popover. */
function useDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  return ref;
}

const triggerCls =
  'flex items-center gap-[7px] rounded-md border bg-card px-3 py-2 text-[12.5px] font-medium text-[var(--brand-ink)] outline-none transition-colors hover:bg-muted/40 dark:text-foreground';
const popoverCls =
  'absolute right-0 z-50 mt-2 w-[280px] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-3 shadow-lg';
// Wider than the plain pickers to make room for the week-number gutter.
const FILTER_POPOVER_W = 318;
const filterPopoverCls =
  'absolute z-50 mt-2 w-[318px] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-3 shadow-lg';

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Why the view moved — lets a caller treat "navigated to a month/year" as
 *  "selected that month/year", while plain chevron paging only browses. */
type ViewChange = 'nav' | 'month' | 'year';

/** ISO week number, read off the row's Thursday so the gutter number matches
 *  the week the row mostly covers. */
function isoWeek(weekStart: Date): number {
  const thu = addDays(weekStart, 4);
  const target = new Date(thu.getFullYear(), thu.getMonth(), thu.getDate());
  target.setDate(target.getDate() + 4 - (target.getDay() || 7));
  const yearStart = new Date(target.getFullYear(), 0, 1);
  return Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** Years offered by the dropdown — a decade back through next year, plus
 *  whatever year is currently in view so it can never fall off the list. */
function yearOptions(current: number): number[] {
  const now = new Date().getFullYear();
  const years = new Set<number>();
  for (let y = now - 10; y <= now + 1; y++) years.add(y);
  years.add(current);
  return Array.from(years).sort((a, b) => b - a);
}

/**
 * The single month grid behind every picker here. `isSelected`/`isInRange`
 * drive styling and `onPick` fires the chosen day, so the same grid serves a
 * single date, a range, or a whole week/month/year without changing shape.
 *
 * `withDropdowns` swaps the static month/year caption for month and year
 * selects, and reports *why* the view moved so a caller can treat picking a
 * month or year as selecting it. Passing `onPickWeek` adds the week-number
 * gutter, making each row clickable as a whole week.
 */
function MonthGrid({
  view,
  setView,
  onPick,
  isSelected,
  isInRange,
  isToday,
  withDropdowns = false,
  onHoverDay,
  onPickWeek,
  onHoverWeek,
}: {
  view: Date;
  setView: (d: Date, why?: ViewChange) => void;
  onPick: (d: Date) => void;
  isSelected: (d: Date) => boolean;
  isInRange: (d: Date) => boolean;
  isToday: (d: Date) => boolean;
  withDropdowns?: boolean;
  onHoverDay?: (d: Date | null) => void;
  onPickWeek?: (weekStart: Date) => void;
  onHoverWeek?: (weekStart: Date | null) => void;
}) {
  // Rows of 7, null-padded at both ends so days keep their weekday columns.
  const rows = useMemo(() => {
    const year = view.getFullYear();
    const month = view.getMonth();
    const startDow = new Date(year, month, 1).getDay();
    const days = new Date(year, month + 1, 0).getDate();
    const flat: (Date | null)[] = [];
    for (let i = 0; i < startDow; i++) flat.push(null);
    for (let d = 1; d <= days; d++) flat.push(new Date(year, month, d));
    while (flat.length % 7 !== 0) flat.push(null);
    const out: (Date | null)[][] = [];
    for (let i = 0; i < flat.length; i += 7) out.push(flat.slice(i, i + 7));
    return out;
  }, [view]);

  const selectCls =
    'cursor-pointer rounded-md border-none bg-transparent px-1 py-0.5 text-[12.5px] font-semibold outline-none hover:bg-muted';
  // The gutter adds a leading column; without it the grid is the plain 7-up.
  const gridCls = onPickWeek ? 'grid grid-cols-[26px_repeat(7,1fr)] gap-0.5' : 'grid grid-cols-7 gap-0.5';
  // A row's week always starts on its Sunday, even when that Sunday belongs to
  // the previous month and renders as a blank cell.
  const weekStartOf = (row: (Date | null)[]) => {
    const first = row.find((d): d is Date => d !== null)!;
    return addDays(first, -first.getDay());
  };

  return (
    <div onMouseLeave={() => { onHoverDay?.(null); onHoverWeek?.(null); }}>
      <div className="mb-2 flex items-center justify-between gap-1">
        <button type="button" onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1), 'nav')} className="grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-muted" aria-label="Previous month">
          <ChevronLeft className="h-4 w-4" />
        </button>
        {withDropdowns ? (
          <div className="flex items-center gap-1">
            <select
              value={view.getMonth()}
              onChange={(e) => setView(new Date(view.getFullYear(), Number(e.target.value), 1), 'month')}
              className={selectCls}
              aria-label="Month"
            >
              {MONTHS_LONG.map((m, i) => <option key={m} value={i}>{m}</option>)}
            </select>
            <select
              value={view.getFullYear()}
              onChange={(e) => setView(new Date(Number(e.target.value), view.getMonth(), 1), 'year')}
              className={selectCls}
              aria-label="Year"
            >
              {yearOptions(view.getFullYear()).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        ) : (
          <div className="text-[12.5px] font-semibold">{view.toLocaleDateString([], { month: 'long', year: 'numeric' })}</div>
        )}
        <button type="button" onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1), 'nav')} className="grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-muted" aria-label="Next month">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className={gridCls}>
        {onPickWeek && <div className="pb-1 text-center text-[10px] font-semibold uppercase text-muted-foreground">Wk</div>}
        {WEEKDAYS.map((w) => (
          <div key={w} className="pb-1 text-center text-[10px] font-semibold uppercase text-muted-foreground">{w}</div>
        ))}
        {rows.map((row, r) => {
          const ws = weekStartOf(row);
          return (
            <Fragment key={`r${r}`}>
              {onPickWeek && (
                <button
                  type="button"
                  onClick={() => onPickWeek(ws)}
                  onMouseEnter={() => onHoverWeek?.(ws)}
                  title={`Select week of ${ws.toLocaleDateString([], { month: 'short', day: 'numeric' })}`}
                  className="grid h-8 place-items-center rounded-md text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {isoWeek(ws)}
                </button>
              )}
              {row.map((d, i) =>
                d === null ? (
                  <div key={`e${r}-${i}`} />
                ) : (
                  <button
                    key={toISO(d)}
                    type="button"
                    onClick={() => onPick(d)}
                    // Only onHoverDay here: it already resolves to a preview or
                    // to nothing, so it supersedes any week preview on its own.
                    // Clearing the week too would wipe the preview it just set.
                    onMouseEnter={() => onHoverDay?.(d)}
                    className={[
                      'grid h-8 place-items-center rounded-md text-[12px] transition-colors',
                      isSelected(d)
                        ? 'bg-primary font-semibold text-primary-foreground'
                        : isInRange(d)
                          ? 'bg-primary/15 text-foreground'
                          : 'hover:bg-muted',
                      isToday(d) && !isSelected(d) ? 'font-bold text-primary ring-1 ring-primary/40' : '',
                    ].join(' ')}
                  >
                    {d.getDate()}
                  </button>
                ),
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Range calendar picker (req 8) — one click on the trigger opens the calendar.
 * Supports preset shortcuts plus explicit from/to day selection. Value is
 * `{ from, to }` as yyyy-mm-dd strings ('' = unbounded).
 */
export function DateRangePicker({
  value,
  onChange,
  placeholder = 'Date range',
}: {
  value: DateRange;
  onChange: (v: DateRange) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const [view, setView] = useState(() => (value.from ? parseISO(value.from) : new Date()));

  const label = value.from && value.to
    ? value.from === value.to ? fmt(value.from) : `${fmtShort(value.from)} – ${fmtShort(value.to)}`
    : value.from ? `From ${fmtShort(value.from)}`
    : value.to ? `Until ${fmtShort(value.to)}`
    : placeholder;
  const active = !!(value.from || value.to);

  function pick(d: Date) {
    const iso = toISO(d);
    // No range yet, or a full range exists → start a new range.
    if (!value.from || (value.from && value.to)) {
      onChange({ from: iso, to: '' });
    } else {
      // Second click completes the range (swap if earlier than the start).
      if (iso < value.from) onChange({ from: iso, to: value.from });
      else { onChange({ from: value.from, to: iso }); setOpen(false); }
    }
  }

  function preset(from: Date, to: Date) {
    onChange({ from: toISO(from), to: toISO(to) });
    setView(from);
    setOpen(false);
  }

  const today = startOfToday();
  const PRESETS: [string, () => void][] = [
    ['Today', () => preset(today, today)],
    ['Yesterday', () => preset(addDays(today, -1), addDays(today, -1))],
    ['Last 7 days', () => preset(addDays(today, -6), today)],
    ['Last 30 days', () => preset(addDays(today, -29), today)],
    ['This month', () => preset(new Date(today.getFullYear(), today.getMonth(), 1), today)],
  ];

  return (
    <div ref={ref} className="relative inline-block">
      <button type="button" onClick={() => setOpen((v) => !v)} className={triggerCls} aria-haspopup="dialog" aria-expanded={open}>
        <CalendarRange className={`h-3.5 w-3.5 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
        <span className={active ? '' : 'text-muted-foreground'}>{label}</span>
        {active && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onChange({ from: '', to: '' }); }}
            className="ml-0.5 text-muted-foreground hover:text-foreground"
            aria-label="Clear dates"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        )}
      </button>

      {open && (
        <div className={popoverCls} role="dialog">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {PRESETS.map(([lbl, fn]) => (
              <button key={lbl} type="button" onClick={fn} className="rounded-full border px-2.5 py-1 text-[11px] font-medium hover:bg-muted">
                {lbl}
              </button>
            ))}
          </div>
          <MonthGrid
            view={view}
            setView={setView}
            onPick={pick}
            isSelected={(d) => { const i = toISO(d); return i === value.from || i === value.to; }}
            isInRange={(d) => !!(value.from && value.to && toISO(d) > value.from && toISO(d) < value.to)}
            isToday={(d) => toISO(d) === toISO(today)}
          />
          <div className="mt-2 flex items-center justify-between border-t pt-2 text-[11.5px]">
            <span className="text-muted-foreground">
              {value.from ? (value.to ? `${fmtShort(value.from)} – ${fmtShort(value.to)}` : `${fmtShort(value.from)} – …`) : 'Pick a start date'}
            </span>
            <button type="button" onClick={() => setOpen(false)} className="font-semibold text-primary hover:underline">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── week/month/year helpers ──
const startOfWeek = (d: Date) => addDays(d, -d.getDay()); // Sunday-based, matches the grid
const endOfWeek = (d: Date) => addDays(startOfWeek(d), 6);
const firstOfMonth = (y: number, m: number) => new Date(y, m, 1);
const lastOfMonth = (y: number, m: number) => new Date(y, m + 1, 0);
/**
 * Lead Management date filter — one calendar, no mode switcher.
 *
 * Granularity is inferred from what you click rather than chosen up front:
 * a day is a day, a second day extends it into a range, the week gutter takes
 * the whole week, and the month/year dropdowns take the whole month or year.
 * `mode` is therefore an output (it labels the trigger), not an input.
 *
 * Emits `{ mode, from, to }` — the resolved `from`/`to` (yyyy-mm-dd,
 * '' = unbounded) drive the table and KPI cards unchanged.
 */
export function DateFilter({
  value,
  onChange,
  iconOnlyWhenEmpty,
}: {
  value: DateFilterValue;
  onChange: (v: DateFilterValue) => void;
  /** Drop the "All dates" text and show just the icon until a date is picked —
   *  opt-in so every other call site keeps its label. Once a date/range is
   *  picked the label comes back, since it's then real information. */
  iconOnlyWhenEmpty?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const [view, setView] = useState(() => (value.from ? parseISO(value.from) : new Date()));
  const [hover, setHover] = useState<{ from: Date; to: Date } | null>(null);
  const [alignLeft, setAlignLeft] = useState(false);
  const today = startOfToday();

  // The panel hangs off the trigger's right edge by default, which suits a
  // filter sitting at the end of a bar. When the filter is at the *start* of a
  // bar there isn't 318px to its left, and the panel would slide under the app's
  // fixed sidebar — taking the week gutter with it. Measure on open and flip.
  function toggle() {
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect();
      const contentLeft = (ref.current.closest('main')?.getBoundingClientRect().left ?? 0) + 8;
      // Both edges are glass coordinates, so the panel's width has to be one too:
      // `FILTER_POPOVER_W` is a layout px constant, and the shell draws laptops
      // at a scale. Comparing it unconverted made the panel flip left slightly
      // sooner than it needed to.
      const scale = ref.current.offsetWidth > 0 ? r.width / ref.current.offsetWidth : 1;
      setAlignLeft(r.right - FILTER_POPOVER_W * (scale > 0 ? scale : 1) < contentLeft);
    }
    setOpen((v) => !v);
  }

  const set = (mode: DateMode, from: Date | '', to: Date | '') =>
    onChange({ mode, from: from ? toISO(from) : '', to: to ? toISO(to) : '' });

  // First click picks a day; a second, different day extends it into a range.
  // Anything else (a week/month/year already selected) starts over from a day.
  function pickDay(d: Date) {
    const iso = toISO(d);
    if (value.mode === 'day' && value.from && iso !== value.from) {
      const [from, to] = iso < value.from ? [iso, value.from] : [value.from, iso];
      return onChange({ mode: 'custom', from, to });
    }
    set('day', d, d);
  }

  const pickWeek = (weekStart: Date) => set('week', weekStart, endOfWeek(weekStart));

  // Chevrons only browse; choosing from a dropdown selects that whole period.
  function navigate(next: Date, why: ViewChange = 'nav') {
    setView(next);
    if (why === 'month') set('month', firstOfMonth(next.getFullYear(), next.getMonth()), lastOfMonth(next.getFullYear(), next.getMonth()));
    else if (why === 'year') set('year', new Date(next.getFullYear(), 0, 1), new Date(next.getFullYear(), 11, 31));
  }

  // Shading: a hover preview when there is one, else the committed range.
  const shaded = hover
    ? { from: toISO(hover.from), to: toISO(hover.to) }
    : { from: value.from, to: value.to };

  // Hovering a day while one is already picked previews the range it would make.
  const previewDay = (d: Date | null) => {
    if (!d) return setHover(null);
    if (value.mode === 'day' && value.from && toISO(d) !== value.from) {
      const a = parseISO(value.from);
      setHover(d < a ? { from: d, to: a } : { from: a, to: d });
    } else setHover(null);
  };

  const label = (() => {
    if (value.mode === 'all' || (!value.from && !value.to)) return 'All dates';
    if (value.mode === 'day') return fmt(value.from);
    if (value.mode === 'month') return parseISO(value.from).toLocaleDateString([], { month: 'long', year: 'numeric' });
    if (value.mode === 'year') return value.from.slice(0, 4);
    if (value.from && value.to) return value.from === value.to ? fmt(value.from) : `${fmtShort(value.from)} – ${fmtShort(value.to)}`;
    return value.from ? `From ${fmtShort(value.from)}` : `Until ${fmtShort(value.to)}`;
  })();
  const active = value.mode !== 'all' && !!(value.from || value.to);

  // Doubles as the affordance hint — the only cue for what a click will do now
  // that the mode buttons are gone.
  // The trigger already names the selection, so the hint spends its width on
  // what to do next instead of repeating it.
  const hint = (() => {
    if (value.mode === 'all' || (!value.from && !value.to)) return 'Day · week no. · month · year';
    if (value.mode === 'day') return 'Click another day for a range';
    if (value.mode === 'custom' && !value.to) return `${fmtShort(value.from)} – …`;
    return `${fmtShort(value.from)} – ${fmtShort(value.to)}`;
  })();

  return (
    <div ref={ref} className="relative inline-block">
      <button type="button" onClick={toggle} className={triggerCls} aria-haspopup="dialog" aria-expanded={open} title={iconOnlyWhenEmpty && !active ? label : undefined} aria-label={iconOnlyWhenEmpty && !active ? label : undefined}>
        <CalendarRange className={`h-3.5 w-3.5 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
        {!(iconOnlyWhenEmpty && !active) && <span className={active ? '' : 'text-muted-foreground'}>{label}</span>}
        {active && (
          <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); set('all', '', ''); }} className="ml-0.5 text-muted-foreground hover:text-foreground" aria-label="Reset date filter">
            <X className="h-3.5 w-3.5" />
          </span>
        )}
      </button>

      {open && (
        <div className={`${filterPopoverCls} ${alignLeft ? 'left-0' : 'right-0'}`} role="dialog">
          <MonthGrid
            view={view}
            setView={navigate}
            onPick={pickDay}
            onHoverDay={previewDay}
            onPickWeek={pickWeek}
            onHoverWeek={(ws) => setHover(ws ? { from: ws, to: endOfWeek(ws) } : null)}
            withDropdowns
            isSelected={(d) => { const i = toISO(d); return !!shaded.from && (i === shaded.from || i === shaded.to); }}
            isInRange={(d) => !!(shaded.from && shaded.to && toISO(d) > shaded.from && toISO(d) < shaded.to)}
            isToday={(d) => toISO(d) === toISO(today)}
          />

          <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2 text-[11.5px]">
            <span className="truncate text-muted-foreground">{hint}</span>
            <div className="flex shrink-0 items-center gap-2">
              {active && (
                <button type="button" onClick={() => set('all', '', '')} className="text-muted-foreground hover:text-foreground">Clear</button>
              )}
              <button type="button" onClick={() => setOpen(false)} className="font-semibold text-primary hover:underline">Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Single-date calendar picker (req 8). Value is a yyyy-mm-dd string ('' = unset).
 */
export function DatePicker({
  value,
  onChange,
  placeholder = 'Pick a date',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const [view, setView] = useState(() => (value ? parseISO(value) : new Date()));
  const today = startOfToday();

  return (
    <div ref={ref} className="relative inline-block">
      <button type="button" onClick={() => setOpen((v) => !v)} className={triggerCls} aria-haspopup="dialog" aria-expanded={open}>
        <CalendarRange className={`h-3.5 w-3.5 ${value ? 'text-primary' : 'text-muted-foreground'}`} />
        <span className={value ? '' : 'text-muted-foreground'}>{value ? fmt(value) : placeholder}</span>
        {value && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onChange(''); }}
            className="ml-0.5 text-muted-foreground hover:text-foreground"
            aria-label="Clear date"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        )}
      </button>

      {open && (
        <div className={popoverCls} role="dialog">
          <MonthGrid
            view={view}
            setView={setView}
            onPick={(d) => { onChange(toISO(d)); setOpen(false); }}
            isSelected={(d) => toISO(d) === value}
            isInRange={() => false}
            isToday={(d) => toISO(d) === toISO(today)}
          />
        </div>
      )}
    </div>
  );
}
