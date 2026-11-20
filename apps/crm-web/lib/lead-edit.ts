import type { UpdateLeadInput } from './leads';

/**
 * What a lead's Edit form should actually send: only the fields the person
 * changed.
 *
 * The form used to send every field on every save, and three of them were not
 * harmless to send back unchanged:
 *  • the dates were pre-filled as their UTC calendar day, so saving any edit
 *    rewrote a 2:30 pm follow-up to midnight UTC — the previous evening in the
 *    US — and dropped the time;
 *  • Comments was sent back as it stood, and the server records every comment
 *    it receives as a new trail entry, so each save duplicated the latest one;
 *  • Assigned To was re-resolved from the owner's name, so two users sharing a
 *    name could see a lead change hands on an unrelated edit.
 *
 * Compared after trimming, since the server trims too: retyping a value with a
 * trailing space is not a change.
 */
export function leadEditChanges(initial: UpdateLeadInput, form: UpdateLeadInput): UpdateLeadInput {
  const before = initial as Record<string, unknown>;
  const after = form as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (norm(before[key]) !== norm(after[key])) out[key] = after[key] ?? '';
  }
  // Clearing a zone is not an edit this form offers (the option is disabled),
  // and the API refuses an empty zone — so a blank one is never sent.
  if (out.timezone === '') delete out.timezone;
  // A number input hands back a string; the column is an integer, and a cleared
  // box means "no count" rather than zero.
  if ('followupCount' in out) {
    const raw = out.followupCount;
    const n = raw === '' || raw == null ? null : Number(raw);
    if (n !== null && !Number.isInteger(n)) delete out.followupCount;
    else out.followupCount = n;
  }
  return out as UpdateLeadInput;
}

const norm = (v: unknown) => (v == null ? '' : typeof v === 'string' ? v.trim() : String(v));
