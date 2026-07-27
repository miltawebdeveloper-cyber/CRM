'use client';

import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { toast } from './toast';
import { launchQuoCall } from './dialer';
import { useCallingEnabled } from './use-calling-enabled';

/**
 * Whether the signed-in user may place a call — checked BEFORE the Quo app opens.
 *
 * Placing a call is a two-step handoff: launch the Quo app with the number, and
 * log the call through the API. The app handoff only works when fired
 * synchronously inside the click, so the API can't be awaited first — which meant
 * a rep with no assigned caller ID would really dial the customer and only then
 * be told the CRM refused to log it.
 *
 * So mirror the API's precondition here against data already in cache: an agent
 * needs their own Quo number. `guard` returns false and explains why, so a Call
 * button can refuse before anything is dialled; `dial` does both in the order
 * that keeps that promise.
 */
export function useCanCall() {
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get('/auth/me')).data,
    retry: false,
    staleTime: 60_000,
  });

  // Calling can be switched off CRM-wide for lead-processing mode. That outranks
  // everything else here: no dial button should offer an action the API refuses.
  const { callingEnabled, disabledReason } = useCallingEnabled();

  // Until `me` resolves we don't know — don't block a legitimate call on a
  // slow request; the API is still the authority and will reject if needed.
  const known = !!me;
  const canCall = callingEnabled && (!known || !!me.openphoneNumber);
  const reason = !callingEnabled
    ? disabledReason || 'Calling is temporarily disabled.'
    : known && !me.openphoneNumber
      ? 'No caller ID is assigned to your account. Ask an admin to assign your OpenPhone number (Admin → Users) before placing calls.'
      : null;

  /**
   * Call inside a click: returns false (and toasts) when dialling must not go
   * ahead. Memoised so callers can list it as a dependency without rebuilding
   * memoised table columns on every render.
   */
  const guard = useCallback(() => {
    if (canCall) return true;
    toast.error(reason ?? 'You cannot place calls yet.');
    return false;
  }, [canCall, reason]);

  /**
   * Guard, then hand the number to the Quo app — the one call-launch path used by
   * every Call button. Returns false when the call was refused, so the caller can
   * skip the logging step too. Call it directly inside the click: the app handoff
   * is only honoured from a real user gesture.
   *
   * `from` pins the outgoing line to this agent's own Quo number so the customer
   * sees the right caller ID.
   */
  const dial = useCallback(
    (phone?: string | null) => {
      if (!guard()) return false;
      launchQuoCall(phone, me?.openphoneNumber);
      return true;
    },
    [guard, me?.openphoneNumber],
  );

  return {
    canCall,
    reason,
    guard,
    dial,
    fromNumber: (me?.openphoneNumber as string | undefined) ?? null,
    /** False = lead-processing mode: hide dial affordances rather than disable them. */
    callingEnabled,
    disabledReason,
  };
}
