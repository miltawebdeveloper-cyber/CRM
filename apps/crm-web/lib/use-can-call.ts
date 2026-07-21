'use client';

import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { toast } from './toast';

/**
 * Whether the signed-in user may place a call — checked BEFORE the dialer opens.
 *
 * Placing a call is a two-step handoff: open the OpenPhone dialer via a `tel:`
 * link, and log the call through the API. The `tel:` link only works when fired
 * synchronously inside the click, so the API can't be awaited first — which meant
 * a rep with no assigned caller ID would really dial the customer and only then
 * be told the CRM refused to log it.
 *
 * So mirror the API's precondition here against data already in cache: an agent
 * needs their own OpenPhone number. `guard` returns false and explains why, so a
 * Call button can refuse before anything is dialled.
 */
export function useCanCall() {
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get('/auth/me')).data,
    retry: false,
    staleTime: 60_000,
  });

  // Until `me` resolves we don't know — don't block a legitimate call on a
  // slow request; the API is still the authority and will reject if needed.
  const known = !!me;
  const canCall = !known || !!me.openphoneNumber;
  const reason = known && !me.openphoneNumber
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

  return { canCall, reason, guard };
}
