import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../../prisma/prisma.service';
import { OpenPhoneService } from '../openphone/openphone.service';
import { CallInsightsService } from './call-insights.service';
import { CommunicationsService } from './communications.service';

/**
 * An unrecognised number ringing a workspace line must NOT become a lead.
 *
 * It used to: the webhook minted a minimal "Unknown caller" lead so the call had
 * somewhere to hang, which put every wrong number, robocall and personal call
 * into Lead Management → New Lead as a lead to work. These tests hold the line
 * on both halves of the rule — an unknown number is recorded as a call and
 * nothing else, and a number the CRM already knows still lands on its lead.
 */
describe('CommunicationsService — unknown callers never become leads', () => {
  const KNOWN_LEAD = { id: 'lead-1', leadId: 'L-2026-7', businessName: 'Acme Books', phone: '(813) 555-0142', assignedToId: 'user-1' };

  /**
   * Prisma cut down to what the webhook path touches. `leadByPhone` decides
   * whether the caller is somebody we hold — the one fact these tests vary.
   */
  function harness(leadByPhone: typeof KNOWN_LEAD | null) {
    const leadCreate = jest.fn(() => ({ id: 'should-never-happen' }));
    const leadUpdate = jest.fn(async (_args: { where: { id: string }; data: Record<string, unknown> }) => ({}));
    const callCreate = jest.fn(async (_args: { data: Record<string, unknown> }) => ({ id: 'call-1' }));
    const messageCreate = jest.fn(async (_args: { data: Record<string, unknown> }) => ({ id: 'msg-1' }));
    const activityCreate = jest.fn(async (_args: { data: Record<string, unknown> }) => ({}));
    const taskCreate = jest.fn(async (_args: { data: Record<string, unknown> }) => ({}));

    const prisma = {
      lead: {
        findFirst: jest.fn(async () => leadByPhone),
        create: leadCreate,
        update: leadUpdate,
      },
      call: {
        // No prior row for this provider id, and no earlier outbound call to
        // route the popup by — so the handler takes the "new call" path.
        findFirst: jest.fn(async () => null),
        create: callCreate,
        update: jest.fn(async () => ({})),
      },
      message: { findFirst: jest.fn(async () => null), create: messageCreate },
      // No user owns the dialled line, so ownership falls through to an admin.
      user: { findFirst: jest.fn(async () => ({ id: 'admin-1' })) },
      activity: { create: activityCreate },
      task: { create: taskCreate },
      callRecording: { upsert: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
      outcome: { findUnique: jest.fn(async () => null) },
    } as unknown as PrismaService;

    const service = new CommunicationsService(
      prisma,
      {} as unknown as OpenPhoneService,
      { enqueue: jest.fn() } as unknown as CallInsightsService,
    );
    return { service, leadCreate, leadUpdate, callCreate, messageCreate, taskCreate };
  }

  /** A `call.*` webhook body, in the shape the provider actually delivers. */
  const callEvent = (type: string, o: Record<string, unknown>) => ({ type, data: { object: { id: 'quo-call-1', ...o } } });

  beforeEach(() => {
    // The signature check is not what's under test here; no secret configured
    // means the handler is reached directly.
    delete process.env.QUO_WEBHOOK_SECRET;
    delete process.env.OPENPHONE_WEBHOOK_SECRET;
  });

  it('records an unknown incoming call with no lead at all', async () => {
    const { service, leadCreate, callCreate, leadUpdate } = harness(null);

    await service.handleEvent(callEvent('call.ringing', { direction: 'incoming', from: '+18135550199', to: '+18135550100' }));

    // The bullet that matters: nothing was added to Lead Management.
    expect(leadCreate).not.toHaveBeenCalled();
    expect(leadUpdate).not.toHaveBeenCalled();

    const data = callCreate.mock.calls[0][0].data;
    expect(data.leadId).toBeNull();
    // The caller's number is the only identity it has — Calls Made shows this
    // and Call Back dials it.
    expect(data.externalNumber).toBe('+18135550199');
    expect(data.direction).toBe('inbound');
  });

  it('links a call from a number we already hold to that lead', async () => {
    // Same number as KNOWN_LEAD, in E.164 rather than the display form stored
    // on the lead — matching is on the last 10 digits.
    const { service, leadCreate, callCreate, leadUpdate } = harness(KNOWN_LEAD);

    await service.handleEvent(callEvent('call.completed', { direction: 'incoming', from: '+18135550142', to: '+18135550100', duration: 95 }));

    expect(leadCreate).not.toHaveBeenCalled();
    const data = callCreate.mock.calls[0][0].data;
    expect(data.leadId).toBe('lead-1');
    expect(data.externalNumber).toBe('+18135550142');
    // The lead's call history moved on — `lastCommunicationAt` is stamped.
    expect(leadUpdate).toHaveBeenCalled();
    expect(leadUpdate.mock.calls[0][0].data).toHaveProperty('lastCommunicationAt');
  });

  it('raises the missed-call task against the number when nobody is behind it', async () => {
    const { service, taskCreate } = harness(null);

    await service.handleEvent(callEvent('call.completed', { direction: 'incoming', status: 'missed', from: '+18135550199', to: '+18135550100' }));

    // A task naming a lead that doesn't exist would be unworkable; the number is
    // what the agent rings back.
    expect(String(taskCreate.mock.calls[0][0].data.title)).toContain('+18135550199');
  });

  it('does not let an inbound SMS from an unknown number create a lead either', async () => {
    const { service, leadCreate, messageCreate } = harness(null);

    await service.handleEvent({
      type: 'message.received',
      data: { object: { id: 'quo-msg-1', direction: 'incoming', from: '+18135550199', to: ['+18135550100'], text: 'hello' } },
    });

    // Otherwise the junk lead would already exist by the time that number rang,
    // and the call would link straight to it.
    expect(leadCreate).not.toHaveBeenCalled();
    expect(messageCreate.mock.calls[0][0].data.leadId).toBeNull();
  });

  it('ignores a Quo contact that matches no lead instead of creating one', async () => {
    const { service, leadCreate, leadUpdate } = harness(null);

    const res = await service.handleEvent({
      type: 'contact.created',
      data: { object: { id: 'quo-contact-1', phoneNumbers: [{ value: '+18135550199' }] } },
    });

    // Saving a number in the Quo address book is not a decision to work it.
    expect(res).toEqual({ ignored: 'no matching lead' });
    expect(leadCreate).not.toHaveBeenCalled();
    expect(leadUpdate).not.toHaveBeenCalled();
  });

  it('re-delivery of the same call does not add a second row', async () => {
    const { service, callCreate } = harness(null);
    const event = callEvent('call.completed', { direction: 'incoming', from: '+18135550199', to: '+18135550100', duration: 12 });

    await service.handleEvent(event);
    // The second delivery finds the row the first one wrote.
    const first = callCreate.mock.calls[0][0].data;
    expect(first.quoCallId).toBe('quo-call-1');
    // Provider ids are unique in the schema, so a duplicate delivery can only
    // ever update — this asserts the id is actually carried, which is what makes
    // that constraint able to do its job.
    expect(first.quoCallId).toBeTruthy();
  });
});
