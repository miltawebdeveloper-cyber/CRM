import { Injectable } from '@nestjs/common';
import { OpenPhoneClient } from './openphone.client';
import { OpenPhoneMessagePayload, OpenPhoneContactPayload, OpenPhoneHistoryQuery } from './openphone.types';

@Injectable()
export class OpenPhoneService {
  constructor(private readonly client: OpenPhoneClient) {}

  get isSandbox() {
    return this.client.isSandbox;
  }

  /** Live connection check — verifies credentials by listing phone numbers. */
  async status() {
    const res = await this.client.listPhoneNumbers();
    return {
      provider: 'OpenPhone',
      sandbox: this.client.isSandbox,
      connected: res.success,
      phoneNumbers: res.data ?? [],
      error: res.success ? null : res.error ?? null,
    };
  }

  sendSms(payload: OpenPhoneMessagePayload) {
    return this.client.sendMessage(payload);
  }

  createContact(payload: OpenPhoneContactPayload) {
    return this.client.createContact(payload);
  }

  /** Workspace numbers, used as the `phoneNumberId` side of every history pull. */
  async phoneNumbers() {
    const res = await this.client.listPhoneNumbers();
    return res.success ? res.data ?? [] : [];
  }

  listConversations(opts: { maxResults?: number; pageToken?: string } = {}) {
    return this.client.listConversations(opts);
  }

  listCalls(q: OpenPhoneHistoryQuery) {
    return this.client.listCalls(q);
  }

  listMessages(q: OpenPhoneHistoryQuery) {
    return this.client.listMessages(q);
  }

  getCallRecordings(callId: string) {
    return this.client.getCallRecordings(callId);
  }

  /** AI transcript (dialogue turns) for a call — used to build the call summary. */
  getCallTranscript(callId: string) {
    return this.client.getCallTranscript(callId);
  }
}
