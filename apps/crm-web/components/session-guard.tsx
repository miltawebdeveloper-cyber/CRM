'use client';

import { useEffect } from 'react';
import { ACCESS_KEY, subjectOf, tokenStore } from '@/lib/api';

/**
 * Keeps a tab honest about whose session it is showing.
 *
 * Tokens live in `localStorage`, which every tab on this origin shares. So a
 * tab signed in as one person did not notice when someone signed in as another
 * in a second tab: it went on rendering the first account's name, role and
 * cached rows, while every request it sent from that moment carried the SECOND
 * account's bearer token. Anything done from the stale tab — an edit, a call
 * logged, a lead reassigned — was recorded as the wrong user, and nothing on
 * screen suggested it would be.
 *
 * The `storage` event fires only in the tabs that did NOT make the change,
 * which is exactly the set that needs to hear about it. Comparing the token's
 * SUBJECT rather than its text is what keeps an ordinary token refresh in
 * another tab from bouncing this one: a refresh renews a session, it never
 * changes whose it is (see `doRefresh`), so the subject holds steady and this
 * stays quiet.
 *
 * Recovery is a full navigation, never a router push — the React Query cache
 * has to go with the session, or the new account arrives to find the previous
 * one's data already on screen. That is the same reason logout leaves the page
 * rather than pushing.
 */
export function SessionGuard() {
  useEffect(() => {
    // Whose session this tab believes it is showing. Captured on mount: there is
    // nothing to protect in a tab that was never signed in.
    const mine = subjectOf(tokenStore.access);
    if (!mine) return;

    function onStorage(e: StorageEvent) {
      // `key === null` is a wholesale localStorage.clear() — that concerns us too.
      if (e.key !== null && e.key !== ACCESS_KEY) return;

      const now = subjectOf(tokenStore.access);
      if (now === mine) return; // same session, merely renewed

      // Signed in as somebody else here, or signed out entirely.
      window.location.href = now ? '/dashboard' : '/login';
    }

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return null;
}
