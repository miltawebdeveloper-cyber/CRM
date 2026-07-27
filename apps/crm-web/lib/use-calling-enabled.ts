'use client';

import { useQuery } from '@tanstack/react-query';
import { callingModeApi, type CallingMode } from './crm';

/** Assume calling works until told otherwise — a slow settings fetch must not
 *  silently strand an agent who can in fact dial. */
const OPTIMISTIC: CallingMode = { callingEnabled: true, disabledReason: '' };

/**
 * Is the CRM allowed to place calls right now?
 *
 * Drives the temporary lead-processing mode: when an admin turns calling off,
 * every dial affordance disappears (Call buttons, dial pad, in-call controls,
 * the queue's auto-dial) while the queue workflow — lead card, outcome, notes,
 * save and advance — carries on unchanged. The API enforces the same rule, so
 * this is about not offering an action that would be refused, not about
 * security.
 *
 * Cached briefly and refetched on focus so flipping the switch reaches agents
 * who already have the panel open, without a poll per second.
 */
export function useCallingEnabled() {
  const { data = OPTIMISTIC, isLoading } = useQuery({
    queryKey: ['calling-mode'],
    queryFn: callingModeApi.get,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  return {
    callingEnabled: data.callingEnabled,
    /** Why it's off — shown wherever a Call button used to be. */
    disabledReason: data.disabledReason,
    loading: isLoading,
  };
}
