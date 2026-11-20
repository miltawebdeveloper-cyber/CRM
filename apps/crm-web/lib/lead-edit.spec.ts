import { describe, expect, it } from '@jest/globals';
import { leadEditChanges } from './lead-edit';
import type { UpdateLeadInput } from './leads';

const SEED: UpdateLeadInput = {
  phone: '3055550100',
  comments: 'Left voicemail',
  caller: 'ann@example.com',
  nextFollowUpDate: '2026-11-20T14:30',
  timezone: '',
  followupCount: 2,
};

describe('leadEditChanges', () => {
  it('sends nothing when nothing was touched', () => {
    expect(leadEditChanges(SEED, { ...SEED })).toEqual({});
  });

  it('sends only the field that changed — not the dates, comment or owner beside it', () => {
    expect(leadEditChanges(SEED, { ...SEED, phone: '3055550199' })).toEqual({ phone: '3055550199' });
  });

  it("ignores whitespace the server would trim anyway", () => {
    expect(leadEditChanges(SEED, { ...SEED, comments: 'Left voicemail  ' })).toEqual({});
  });

  it('sends a cleared field as empty, which the API reads as "clear it"', () => {
    expect(leadEditChanges(SEED, { ...SEED, nextFollowUpDate: '' })).toEqual({ nextFollowUpDate: '' });
    expect(leadEditChanges(SEED, { ...SEED, caller: '' })).toEqual({ caller: '' });
  });

  it('never sends a blank zone', () => {
    expect(leadEditChanges({ ...SEED, timezone: 'EST' }, { ...SEED, timezone: '' })).toEqual({});
  });

  it('sends the follow-up count as a number, or null when the box is emptied', () => {
    expect(leadEditChanges(SEED, { ...SEED, followupCount: '3' as unknown as number })).toEqual({ followupCount: 3 });
    expect(leadEditChanges(SEED, { ...SEED, followupCount: '' as unknown as number })).toEqual({ followupCount: null });
    expect(leadEditChanges(SEED, { ...SEED, followupCount: '2.5' as unknown as number })).toEqual({});
  });
});
