// Run with: npm run -w @crm/database test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideDateRepair,
  duplicateComments,
  isMidnightCut,
  latestChanges,
  type DateChange,
  type TrailNote,
} from './lead-edit-repair-rules.js';

const FIX_AT = new Date('2026-11-21T00:00:00.000Z');

const change = (patch: Partial<DateChange>): DateChange => ({
  activityId: 'a1',
  leadId: 'lead-1',
  label: 'Next follow-up',
  oldValue: '2026-11-20T19:30:00.000Z',
  newValue: '2026-11-20T00:00:00.000Z',
  createdAt: new Date('2026-11-18T10:00:00.000Z'),
  ...patch,
});

describe('isMidnightCut', () => {
  it('matches a value cut to midnight UTC of its own day', () => {
    assert.equal(isMidnightCut('2026-11-20T19:30:00.000Z', '2026-11-20T00:00:00.000Z'), true);
  });

  it('does not match a date someone moved to another day', () => {
    assert.equal(isMidnightCut('2026-11-20T19:30:00.000Z', '2026-11-22T00:00:00.000Z'), false);
  });

  it('does not match clearing, setting from blank, or a non-midnight result', () => {
    assert.equal(isMidnightCut('2026-11-20T19:30:00.000Z', null), false);
    assert.equal(isMidnightCut(null, '2026-11-20T00:00:00.000Z'), false);
    assert.equal(isMidnightCut('2026-11-20T19:30:00.000Z', '2026-11-20T09:00:00.000Z'), false);
    assert.equal(isMidnightCut('not a date', '2026-11-20T00:00:00.000Z'), false);
  });
});

describe('decideDateRepair', () => {
  it('restores the time the bad save cut off', () => {
    const d = decideDateRepair(change({}), new Date('2026-11-20T00:00:00.000Z'), FIX_AT);
    assert.deepEqual(d, { kind: 'restore', to: new Date('2026-11-20T19:30:00.000Z') });
  });

  it('leaves a field that changed after the bad save', () => {
    assert.deepEqual(decideDateRepair(change({}), new Date('2026-11-25T15:00:00.000Z'), FIX_AT), { kind: 'skip', reason: 'changed since' });
    assert.deepEqual(decideDateRepair(change({}), null, FIX_AT), { kind: 'skip', reason: 'changed since' });
  });

  it('leaves a midnight value chosen after the fix went live', () => {
    const late = change({ createdAt: new Date('2026-11-22T10:00:00.000Z') });
    assert.deepEqual(decideDateRepair(late, new Date('2026-11-20T00:00:00.000Z'), FIX_AT), { kind: 'skip', reason: 'after the fix' });
  });

  it('only ever acts on the latest change to a field', () => {
    const cut = change({ activityId: 'a1' });
    const later = change({ activityId: 'a2', oldValue: '2026-11-20T00:00:00.000Z', newValue: '2026-11-24T00:00:00.000Z', createdAt: new Date('2026-11-19T10:00:00.000Z') });
    const latest = latestChanges([later, cut]).get('lead-1|Next follow-up')!;
    assert.equal(latest.activityId, 'a2');
    assert.deepEqual(decideDateRepair(latest, new Date('2026-11-24T00:00:00.000Z'), FIX_AT), { kind: 'skip', reason: 'not a midnight cut' });
  });
});

describe('duplicateComments', () => {
  const managers = new Set(['mgr']);
  const note = (id: string, text: string, at: string, patch: Partial<TrailNote> = {}): TrailNote => ({
    id, leadId: 'lead-1', text, callId: null, createdById: 'mgr', createdAt: new Date(at), ...patch,
  });

  it('flags a manager re-entry of the remark right before it, keeping the first', () => {
    const notes = [
      note('n1', 'Left voicemail', '2026-11-10T10:00:00Z', { callId: 'call-1', createdById: 'rep' }),
      note('n2', 'Left voicemail', '2026-11-12T09:00:00Z'),
      note('n3', 'Left voicemail ', '2026-11-15T09:00:00Z'),
    ];
    const found = duplicateComments(notes, managers, FIX_AT);
    assert.deepEqual(found.map((f) => f.note.id), ['n2', 'n3']);
    assert.equal(found[0].repeats.id, 'n1');
  });

  it("leaves a rep's own repeat, a call note, a different remark and anything after the fix", () => {
    const notes = [
      note('n1', 'Busy', '2026-11-10T10:00:00Z'),
      note('n2', 'Busy', '2026-11-11T10:00:00Z', { createdById: 'rep' }),
      note('n3', 'Busy', '2026-11-12T10:00:00Z', { callId: 'call-2' }),
      note('n4', 'Call back Friday', '2026-11-13T10:00:00Z'),
      note('n5', 'Call back Friday', '2026-11-22T10:00:00Z'),
    ];
    assert.deepEqual(duplicateComments(notes, managers, FIX_AT), []);
  });

  it('marks the ones made alongside a logged edit by the same person', () => {
    const notes = [note('n1', 'Hot lead', '2026-11-10T10:00:00Z'), note('n2', 'Hot lead', '2026-11-12T09:00:00.000Z')];
    const edits = new Map([['lead-1|mgr', [new Date('2026-11-12T09:00:01.500Z')]]]);
    assert.equal(duplicateComments(notes, managers, FIX_AT, edits)[0].nearEdit, true);
    assert.equal(duplicateComments(notes, managers, FIX_AT)[0].nearEdit, false);
  });
});
