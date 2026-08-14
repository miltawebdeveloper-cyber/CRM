import { describe, expect, it } from '@jest/globals';
import { movementLabel, type Lead } from './leads';

/**
 * `movementLabel` is the one sentence that explains why a lead is sitting on the
 * date it is sitting on, and it is read in two places that must not disagree:
 * the Movement column in the grid, and the Movement column in the exported file.
 * An export is read away from the screen that produced it, so "Moved to next day
 * (3×)" in a spreadsheet has to mean exactly what the row on screen meant.
 */
describe('movementLabel', () => {
  const lead = (over: Partial<Lead>): Lead =>
    ({ assignedTo: { id: 'u1', name: 'Lisa', email: 'lisa@example.com' }, ...over }) as Lead;

  it('names a lead that has only ever been assigned once', () => {
    expect(movementLabel(lead({ assignmentType: 'new_assignment', carriedForwardCount: 0 }))).toBe('Assigned');
  });

  it('names a handover', () => {
    expect(movementLabel(lead({ assignmentType: 'reassignment', carriedForwardCount: 0 }))).toBe('Reassigned');
  });

  it('says a lead moved to the next day, without a count for a single move', () => {
    // "(1×)" reads as a tally where there is nothing to tally.
    expect(movementLabel(lead({ assignmentType: 'carry_forward', carriedForwardCount: 1 }))).toBe('Moved to next day');
  });

  it('counts the moves once there is more than one', () => {
    // The number is the useful part: a lead moved eight times is a lead nobody
    // is reaching, and the current row alone cannot say so.
    expect(movementLabel(lead({ assignmentType: 'carry_forward', carriedForwardCount: 8 }))).toBe('Moved to next day (8×)');
  });

  it('reports past moves on a lead whose latest event was a handover', () => {
    // The lead is now with someone new, and it had already been round three
    // days before it was handed over. Both facts survive into the label.
    expect(movementLabel(lead({ assignmentType: 'reassignment', carriedForwardCount: 3 }))).toBe(
      'Reassigned · moved to next day 3×',
    );
  });

  it('reads naturally when the lead has been round exactly once', () => {
    expect(movementLabel(lead({ assignmentType: 'new_assignment', carriedForwardCount: 1 }))).toBe(
      'Assigned · moved to next day once',
    );
  });

  it('says nothing at all about a lead nobody holds', () => {
    // Empty, not a dash: the caller decides how to render nothing, because the
    // grid wants "—" and a spreadsheet cell wants to be blank.
    expect(movementLabel({ assignmentType: null, carriedForwardCount: 0, assignedTo: null } as Lead)).toBe('');
  });

  it('still calls an owned lead assigned when its history predates the trail', () => {
    // No assignment rows at all — the lead was assigned by a route that predates
    // the history table. It has an owner, so it is assigned; there is simply
    // nothing more to say about how.
    expect(movementLabel(lead({ assignmentType: null, carriedForwardCount: 0 }))).toBe('Assigned');
  });

  it('treats a missing count as no moves rather than NaN', () => {
    // An older API response, or a row from an endpoint that doesn't project the
    // count. `undefined ?? 0` is what keeps "Assigned · moved to next day NaN×"
    // out of an export.
    expect(movementLabel(lead({ assignmentType: 'new_assignment' }))).toBe('Assigned');
  });
});
