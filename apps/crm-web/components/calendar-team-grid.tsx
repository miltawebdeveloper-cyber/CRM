'use client';

import { AlertTriangle, Phone, PhoneCall, Video } from 'lucide-react';
import { clockLabel, dayHeading, HOUR_LIMIT, isOverdue, LOAD_ALPHA, teamLoad, weekday, type DayLoad } from '@/lib/calendar-grid';
import { itemCount, loadShade, type Placed } from '@/lib/calendar-look';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
const hourLabel = (h: number) => clockLabel(h * 60).replace(':00', '');

/** The shading key: one hue, fewer to more. */
export function LoadLegend() {
  return (
    <span className="inline-flex items-center gap-1.5">
      Fewer
      {LOAD_ALPHA.slice(1).map((a, i) => (
        <span key={i} className="h-3 w-3 rounded-[3px] border" style={{ background: `hsl(var(--primary) / ${a})` }} title={['1–2', '3–5', '6–9', '10 or more'][i]} aria-hidden />
      ))}
      More
    </span>
  );
}

/**
 * A manager's week: one row per rep, one cell per day — how many calls,
 * callbacks and meetings each person has, shaded by load, with overdue in red
 * and a warning where too many start in the same hour (three callbacks at
 * 10 AM can't all be kept). Who's overloaded and who's free, at a glance;
 * a day opens that person's schedule.
 *
 * Tasks are personal and aren't counted. Anyone outside the team list who has
 * items here (an admin who organised a meeting) gets a row of their own, and
 * so does work nobody owns.
 */
export function CalendarTeamGrid({ days, today, events, now, people, colours, onOpen }: {
  days: string[]; today: string; events: Placed[]; now: number;
  people: { id: string; name: string }[]; colours: Map<string, string>;
  onOpen: (personId: string, ymd: string) => void;
}) {
  const load = teamLoad(events.map((e) => ({ ownerId: e.ownerId, ymd: e.ymd2, hour: e.hour, type: e.type, overdue: isOverdue(e, now) })));
  const team = new Set(people.map((p) => p.id));
  const names = new Map(events.flatMap((e) => (e.ownerId ? [[e.ownerId, e.assignedTo ?? 'Someone'] as const] : [])));
  const rows = [
    ...[...people].sort(byName).map((p) => ({ ...p, onTeam: true })),
    ...[...load.keys()].filter((id) => id && !team.has(id)).map((id) => ({ id, name: names.get(id) ?? 'Someone', onTeam: false })).sort(byName),
    ...(load.has('') ? [{ id: '', name: 'Unassigned', onTeam: false }] : []),
  ];
  const dayTotal = (ymd: string) => [...load.values()].reduce((n, m) => n + (m.get(ymd)?.total ?? 0), 0);

  if (!rows.length) return <p className="py-12 text-center text-sm text-muted-foreground">No one on the team yet.</p>;

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] table-fixed border-separate border-spacing-1 text-[12px]">
          <caption className="sr-only">Each person’s calls, callbacks and meetings, day by day</caption>
          <thead>
            <tr>
              <th scope="col" className="w-[150px] px-2 pb-1 text-left text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Rep</th>
              {days.map((ymd) => (
                <th key={ymd} scope="col" className="pb-1 text-center font-normal">
                  <span className="block text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{DOW[weekday(ymd)]}</span>
                  <span className={`mx-auto mt-0.5 grid h-7 w-7 place-items-center rounded-full font-display text-[14px] font-semibold ${ymd === today ? 'bg-primary text-primary-foreground' : ''}`}>
                    {Number(ymd.slice(8))}
                  </span>
                  <span className="block text-[10.5px] text-muted-foreground">{dayTotal(ymd) ? itemCount(dayTotal(ymd)) : '—'}</span>
                </th>
              ))}
              <th scope="col" className="w-[88px] px-2 pb-1 text-right text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Week</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const mine = load.get(r.id);
              const week = [...(mine?.values() ?? [])].reduce((t, d) => ({ total: t.total + d.total, overdue: t.overdue + d.overdue }), { total: 0, overdue: 0 });
              return (
                <tr key={r.id || 'unassigned'}>
                  <th scope="row" className="px-2 text-left align-middle font-semibold">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colours.get(r.id) ?? 'var(--viz-working)' }} aria-hidden />
                      <span className="truncate">{r.name}</span>
                    </span>
                  </th>
                  {days.map((ymd) => (
                    <td key={ymd} className="p-0 align-top">
                      <DayCell
                        load={mine?.get(ymd)}
                        past={ymd < today}
                        isToday={ymd === today}
                        label={`${r.name}, ${dayHeading(ymd, today)}`}
                        onOpen={r.onTeam && r.id ? () => onOpen(r.id, ymd) : undefined}
                      />
                    </td>
                  ))}
                  <td className="px-2 text-right align-middle tabular-nums">
                    <span className="block font-semibold">{week.total}</span>
                    {week.overdue > 0 && <span className="block text-[10.5px] font-semibold text-[var(--tone-red-fg-2)]">{week.overdue} overdue</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 px-1 text-[11px] text-muted-foreground">
        <LoadLegend />
        <span className="inline-flex items-center gap-1">
          <AlertTriangle className="h-3.5 w-3.5 text-[var(--tone-amber-fg)]" aria-hidden /> {HOUR_LIMIT} or more starting in the same hour
        </span>
        <span>Click a day to open that person’s schedule.</span>
      </p>
    </div>
  );
}

function DayCell({ load, past, isToday, label, onOpen }: { load?: DayLoad; past: boolean; isToday: boolean; label: string; onOpen?: () => void }) {
  const crowded = load?.busiest && load.busiest.count >= HOUR_LIMIT ? load.busiest : null;
  const body = load ? (
    <>
      <span className="block font-display text-[16px] font-semibold leading-none tabular-nums">{load.total}</span>
      <span className="mt-1.5 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 text-[10.5px] tabular-nums text-muted-foreground">
        {load.call > 0 && <span className="inline-flex items-center gap-0.5"><Phone className="h-3 w-3" aria-hidden />{load.call}</span>}
        {load.callback > 0 && <span className="inline-flex items-center gap-0.5"><PhoneCall className="h-3 w-3" aria-hidden />{load.callback}</span>}
        {load.zoom > 0 && <span className="inline-flex items-center gap-0.5"><Video className="h-3 w-3" aria-hidden />{load.zoom}</span>}
      </span>
      {crowded && (
        <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-[var(--tone-amber-bg)] px-1.5 py-[1px] text-[10px] font-semibold text-[var(--tone-amber-fg)]">
          <AlertTriangle className="h-3 w-3" aria-hidden /> {crowded.count} at {hourLabel(crowded.hour)}
        </span>
      )}
      {load.overdue > 0 && <span className="mt-1 block text-[10px] font-semibold text-[var(--tone-red-fg-2)]">{load.overdue} overdue</span>}
    </>
  ) : (
    <span className="text-muted-foreground/60" aria-hidden>—</span>
  );
  const describe = `${label}: ${load ? itemCount(load.total) : 'nothing booked'}${crowded ? `, ${crowded.count} starting at ${hourLabel(crowded.hour)}` : ''}${load?.overdue ? `, ${load.overdue} overdue` : ''}`;
  const cls = `flex h-full min-h-[78px] w-full flex-col items-center justify-center rounded-lg border px-1 py-2 text-center ${isToday ? 'border-primary' : ''} ${past ? 'opacity-70' : ''}`;
  const style = { background: loadShade(load?.total ?? 0) };
  return onOpen ? (
    <button type="button" onClick={onOpen} aria-label={`${describe} — open the day`} className={`${cls} transition-[filter] hover:brightness-95`} style={style}>{body}</button>
  ) : (
    <div className={cls} style={style} aria-label={describe} role="img">{body}</div>
  );
}
