// The decisions behind `repair-lead-edits.ts`, kept free of any database access
// so they can be tested on their own (`lead-edit-repair-rules.test.ts`).
//
// See the script's header for the bug these repair. In short: the lead page's
// Edit form sent every field back on every save, with the four contact dates
// cut to their UTC calendar day and the latest comment re-sent as a new one.

/** The activity-log label each damaged date field was written under, and its column. */
export const DATE_FIELDS = {
  'Next follow-up': 'nextFollowUpDate',
  'First contact': 'firstContact',
  'Last contact': 'lastContact',
  'Meeting date': 'meetingDate',
} as const;

export type DateLabel = keyof typeof DATE_FIELDS;
export type DateColumn = (typeof DATE_FIELDS)[DateLabel];

export const isDateLabel = (v: string | null | undefined): v is DateLabel => !!v && v in DATE_FIELDS;

/**
 * Whether a logged change is the old form cutting a value down to midnight UTC
 * of its OWN UTC day — the exact signature of the bug.
 *
 * The form pre-filled `value.slice(0, 10)`, so an untouched date came back as
 * that day at 00:00Z. A date someone deliberately changed lands on a different
 * day and does not match; a value that was already midnight UTC wrote no change
 * and left no log row.
 */
export function isMidnightCut(oldValue: string | null, newValue: string | null): boolean {
  if (!oldValue || !newValue) return false;
  const before = new Date(oldValue);
  const after = new Date(newValue);
  if (Number.isNaN(before.getTime()) || Number.isNaN(after.getTime())) return false;
  return after.getTime() !== before.getTime() && after.toISOString() === `${before.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** One `lead_updated` activity row for a date field. */
export interface DateChange {
  activityId: string;
  leadId: string;
  label: DateLabel;
  oldValue: string | null;
  newValue: string | null;
  createdAt: Date;
}

/**
 * The most recent logged change per lead and field.
 *
 * Only the latest matters: if anything changed the field after the bad save,
 * that later change is what the lead should keep, and the damage is moot.
 */
export function latestChanges(changes: DateChange[]): Map<string, DateChange> {
  const out = new Map<string, DateChange>();
  for (const c of changes) {
    const key = `${c.leadId}|${c.label}`;
    const seen = out.get(key);
    if (!seen || c.createdAt.getTime() > seen.createdAt.getTime()) out.set(key, c);
  }
  return out;
}

export type DateDecision =
  | { kind: 'restore'; to: Date }
  | { kind: 'skip'; reason: 'not a midnight cut' | 'after the fix' | 'changed since' };

/**
 * Restore a field only when all three hold:
 *  • its latest logged change is the midnight cut;
 *  • that change was made before the fix went live (`fixAt`) — after it, the
 *    form no longer cuts dates, so a midnight value then was chosen on purpose;
 *  • the lead still holds exactly the damaged value — anything else means it
 *    was changed since, by a call, the rollover or a person, and is left alone.
 */
export function decideDateRepair(latest: DateChange, current: Date | null, fixAt: Date): DateDecision {
  if (!isMidnightCut(latest.oldValue, latest.newValue)) return { kind: 'skip', reason: 'not a midnight cut' };
  if (latest.createdAt.getTime() >= fixAt.getTime()) return { kind: 'skip', reason: 'after the fix' };
  if (!current || current.getTime() !== new Date(latest.newValue!).getTime()) return { kind: 'skip', reason: 'changed since' };
  return { kind: 'restore', to: new Date(latest.oldValue!) };
}

/** A comment on a lead's trail, as the duplicate scan needs it. */
export interface TrailNote {
  id: string;
  leadId: string;
  text: string;
  callId: string | null;
  createdById: string;
  createdAt: Date;
}

/**
 * Comments that look like the old form re-sending the latest remark: a manual
 * entry (no call), by a manager (only they could save that form), made before
 * the fix, whose text is identical to the entry immediately before it on the
 * same lead. The earliest of a run is always kept.
 *
 * This can't be certain — a manager genuinely repeating "left voicemail" on
 * another day looks the same — which is why the script only lists these unless
 * told otherwise. `nearEdit` flags the ones made within seconds of a logged
 * edit by the same person, which is the strongest sign of the form.
 */
export function duplicateComments(
  notesOfOneLead: TrailNote[],
  managerIds: Set<string>,
  fixAt: Date,
  editTimes: Map<string, Date[]> = new Map(),
  nearMs = 5_000,
): { note: TrailNote; repeats: TrailNote; nearEdit: boolean }[] {
  const ordered = [...notesOfOneLead].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const out: { note: TrailNote; repeats: TrailNote; nearEdit: boolean }[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const note = ordered[i];
    const prev = ordered[i - 1];
    if (note.callId !== null) continue;
    if (!managerIds.has(note.createdById)) continue;
    if (note.createdAt.getTime() >= fixAt.getTime()) continue;
    if (note.text.trim() !== prev.text.trim()) continue;
    const edits = editTimes.get(`${note.leadId}|${note.createdById}`) ?? [];
    const nearEdit = edits.some((t) => Math.abs(t.getTime() - note.createdAt.getTime()) <= nearMs);
    out.push({ note, repeats: prev, nearEdit });
  }
  return out;
}
