/** A phone number provisioned in the connected OpenPhone workspace. */
export interface OpenPhoneNumber {
  id: string;
  number: string; // E.164
  name?: string;
}

/** Outbound SMS payload (OpenPhone POST /messages). */
export interface OpenPhoneMessagePayload {
  from: string; // an OpenPhone number / id
  to: string[]; // recipient E.164 numbers
  content: string;
}

/** Create-contact payload (OpenPhone POST /contacts). */
export interface OpenPhoneContactPayload {
  defaultFields: {
    firstName?: string;
    lastName?: string;
    company?: string;
    phoneNumbers?: { name?: string; value: string }[];
    emails?: { name?: string; value: string }[];
  };
  externalId?: string; // our lead.id — enables idempotent upsert on their side
  source?: string;
}

/** Contact as returned by OpenPhone. */
export interface OpenPhoneContact {
  id: string;
  externalId?: string | null;
  [key: string]: unknown; // tolerate the full defaultFields/customFields shape
}

/**
 * Quo/OpenPhone requires BOTH a workspace number and a participant to list
 * calls or messages — there is no workspace-wide feed, and only 1:1
 * conversations are supported. See https://www.quo.com/docs/api-reference.
 */
export interface OpenPhoneHistoryQuery {
  phoneNumberId: string;
  /** The customer's number in E.164 — the other side of the 1:1 conversation. */
  participant: string;
  maxResults?: number; // 1..100
  pageToken?: string;
  createdAfter?: string; // ISO 8601
  /** Sandbox only: the workspace number in E.164, so simulated history shows a
   *  real-looking sender instead of the internal phoneNumberId. */
  selfNumber?: string;
}

/** One page of history results. */
export interface OpenPhonePage<T> {
  data: T[];
  nextPageToken?: string | null;
}

/**
 * A conversation as returned by GET /v1/conversations. Unlike calls/messages,
 * this endpoint needs no participant, so it's how the CRM discovers which
 * (workspace number × customer number) pairs actually have history.
 */
export interface OpenPhoneConversation {
  id: string;
  phoneNumberId: string;
  participants: string[];
  lastActivityAt?: string;
  lastActivityId?: string;
  name?: string | null;
  deletedAt?: string | null;
}

/** A call as returned by GET /v1/calls. */
export interface OpenPhoneCall {
  id: string;
  direction?: string; // incoming | outgoing
  status?: string;
  duration?: number; // seconds
  from?: string;
  to?: string | string[];
  conversationId?: string;
  createdAt?: string;
  completedAt?: string;
  answeredAt?: string;
  userId?: string;
}

/** A message as returned by GET /v1/messages. */
export interface OpenPhoneMessage {
  id: string;
  direction?: string; // incoming | outgoing
  /** queued | sent | delivered | undelivered | received */
  status?: string;
  text?: string;
  body?: string;
  from?: string;
  to?: string | string[];
  conversationId?: string;
  createdAt?: string;
  userId?: string;
}

/** A recording segment from GET /v1/call-recordings/{callId}. */
export interface OpenPhoneRecording {
  id: string;
  url?: string | null;
  duration?: number | null; // seconds
  startTime?: string | null;
  status?: string | null; // completed | in-progress | failed
  type?: string | null; // e.g. audio/mpeg
}

/** Normalized result envelope for any OpenPhone call. */
export interface OpenPhoneResult<T = unknown> {
  success: boolean;
  statusCode?: number;
  data?: T;
  error?: string;
  durationMs: number;
}
