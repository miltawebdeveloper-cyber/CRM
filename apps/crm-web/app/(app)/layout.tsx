'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api, tokenStore } from '@/lib/api';
import { canAccessPath, type Role } from '@/lib/nav';
import { loginUrl } from '@/lib/return-to';
import { setBusinessTimezone } from '@/lib/business-day';
import { Sidebar } from '@/components/sidebar';
import { Topbar } from '@/components/topbar';
import { IncomingCallPopup } from '@/components/incoming-call';
import { CallbackReminders } from '@/components/callback-reminder';
import { CommandPalette } from '@/components/command-palette';
import { SessionGuard } from '@/components/session-guard';
import { CallProvider } from '@/components/call-provider';
import { PageTabsProvider } from '@/components/page-tabs';
import { DisplaySettingsProvider } from '@/components/display-settings-provider';
import { TimezoneOptionsSync } from '@/components/timezone-options-sync';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const mainRef = useRef<HTMLElement>(null);
  // Below `lg` the sidebar is an off-canvas drawer rather than a column — a
  // 248px rail on a 375px phone leaves no room for the page. The open state
  // lives here because the two components that need it are siblings: the
  // topbar's menu button opens it, the sidebar renders it.
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    // Carries the page asked for, so signing in lands on it rather than on the
    // dashboard — a lead link opened from an e-mail after the session lapsed.
    if (!tokenStore.access) router.replace(loginUrl(window.location.pathname + window.location.search));
  }, [router]);

  const {
    data: me,
    isPending: mePending,
    isError: meErrored,
    refetch: refetchMe,
  } = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const data = (await api.get('/auth/me')).data;
      // Before anything below renders a date preset: which zone "today" is on.
      setBusinessTimezone(data?.businessTimezone);
      return data;
    },
    retry: false,
  });

  /**
   * Scroll position on navigation.
   *
   * This app scrolls `<main>`, not the window, and Next's own scroll handling
   * only knows about the window. So the shell resets `<main>` to the top on a
   * new navigation — and, on Back or Forward, puts it back where that page was
   * left, which it used to reset too: a Back from a lead to a long list landed
   * at the top of the list.
   *
   * Positions are remembered per path, from the scroll events themselves. The
   * path they are filed under moves in a LAYOUT effect, before the browser can
   * dispatch the scroll event that swapping the content causes — otherwise that
   * event would file the new page's clamped position under the old page.
   */
  const scrollByPath = useRef(new Map<string, number>());
  const scrollPath = useRef(pathname);
  // The path a Back/Forward is going to — matched against the path that then
  // renders, so a history step that only changes the query string can't leave
  // the next ordinary click restoring a position instead of starting at the top.
  const historyMove = useRef<string | null>(null);
  useEffect(() => {
    const onPop = () => { historyMove.current = window.location.pathname; };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // `<main>` only exists once the account has loaded, so this re-binds then.
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const onScroll = () => scrollByPath.current.set(scrollPath.current, main.scrollTop);
    main.addEventListener('scroll', onScroll, { passive: true });
    return () => main.removeEventListener('scroll', onScroll);
  }, [mePending, meErrored]);
  useLayoutEffect(() => {
    scrollPath.current = pathname;
    const main = mainRef.current;
    if (!main) return;
    const restoring = historyMove.current === pathname;
    historyMove.current = null;
    if (!restoring) {
      main.scrollTop = 0;
      return;
    }
    const target = scrollByPath.current.get(pathname) ?? 0;
    // The page may still be growing to its full height — rows painting from
    // cache, a second chunk — so keep trying for a few frames until it fits.
    let frames = 0;
    let raf = 0;
    const restore = () => {
      main.scrollTop = target;
      if (Math.abs(main.scrollTop - target) > 2 && frames++ < 20) raf = requestAnimationFrame(restore);
    };
    restore();
    return () => cancelAnimationFrame(raf);
  }, [pathname]);

  // RBAC: bounce a role away from a page it may not access.
  const role = me?.role as Role | undefined;
  const allowed = !role || canAccessPath(pathname, role);
  useEffect(() => {
    if (role && !canAccessPath(pathname, role)) router.replace('/dashboard');
  }, [role, pathname, router]);

  return (
    // Outermost, so the user's zone and language are published to the
    // formatters before anything below renders a timestamp.
    <DisplaySettingsProvider>
    <CallProvider>
      {/* Wraps the topbar and the page together, so a page can render its view
          tabs into the slot the topbar exposes beside the title. */}
      <PageTabsProvider>
      {/* `min-w-0` on the content column is what stops a wide table stretching the
          flex row and pushing the page off-screen — without it the shell grows to
          the table's width and the whole document scrolls sideways.

          `h-screen` is the height, always. `app-shell` (globals.css) adds the
          laptop scaling on top: between 1280 and 1499px it scales the WHOLE
          subtree by one factor, so a laptop shows the desktop layout intact
          rather than a reflowed one, and overrides the height to match. At
          1500px and up it does nothing at all.

          The height stays HERE rather than moving into `.app-shell` because the
          shell must have one even if that rule never applies — dropping
          `h-screen` in favour of a computed height left the whole app with no
          height the moment the computed one failed to parse.

          Every overlay below is inside the shell deliberately, so dialogs,
          drawers and the command palette scale with the page rather than
          floating over it at a different size. */}
      <div className="app-shell flex h-screen overflow-hidden bg-background">
        {mePending ? (
          // Neutral shell — no Sidebar, no Topbar, no page content, nothing that
          // reads a role. Sidebar/Topbar/CommandPalette and every page below all
          // read this same `['me']` cache entry (React Query dedupes by key), so
          // none of them need their own gate — by the time any of them mounts,
          // the cache is already populated and their own `useQuery(['me'])` reads
          // it synchronously on first render. This is the one choke point.
          <div className="grid h-screen w-full place-items-center" role="status" aria-live="polite">
            <div className="text-center">
              <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Loading your workspace…</p>
            </div>
          </div>
        ) : meErrored ? (
          // `/auth/me` failed for a reason that ISN'T a 401 — a 401 is caught by
          // lib/api.ts's interceptor first (silent refresh-and-retry, or a hard
          // bounce to /login) and only reaches here as a final rejection if that
          // also fails. What lands here is realistically a network error or a
          // 5xx. No role is known either way, so nothing role-gated may render.
          <div className="grid h-screen w-full place-items-center" role="status" aria-live="polite">
            <div className="text-center">
              <p className="font-display text-lg font-semibold">Couldn’t load your account</p>
              <p className="mt-1 text-sm text-muted-foreground">Check your connection and try again.</p>
              <button
                type="button"
                onClick={() => refetchMe()}
                className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                Retry
              </button>
            </div>
          </div>
        ) : (
          <>
            <Sidebar mobileOpen={navOpen} onClose={() => setNavOpen(false)} />
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <Topbar email={me?.email} onMenu={() => setNavOpen(true)} />
              <main ref={mainRef} className="flex-1 overflow-y-auto">
                {/* max-w-[1500px] is the DESIGN WIDTH the laptop `zoom` bands above are
                    calibrated against (globals.css) — it must stay exactly 1500 through
                    that range or the scaled bands stop fitting their real viewport.
                    Those bands top out at 1499.98px and do nothing from 1500px up, so
                    widening the cap only there (min-[1500px]) is the one place it's safe
                    to give wide/desktop monitors more than the laptop-era 1500px column
                    without touching the calibrated math. */}
                <div className="mx-auto w-full max-w-[1500px] min-[1500px]:max-w-[1800px] p-4 sm:p-6">
                  {allowed ? children : (
                    <div className="grid h-[60vh] place-items-center text-center">
                      <div>
                        <p className="font-display text-lg font-semibold">Access restricted</p>
                        <p className="mt-1 text-sm text-muted-foreground">You don’t have permission to view this page. Redirecting…</p>
                      </div>
                    </div>
                  )}
                </div>
              </main>
            </div>
            {/* Watches for another tab signing in as someone else. Renders nothing;
                it exists so this tab can never keep showing one account while
                acting as another. */}
            <SessionGuard />
            {/* Keeps the admin-managed zone list current for every picker,
                filter and formatter in lib/timezone.ts. Renders nothing. */}
            <TimezoneOptionsSync />
            <IncomingCallPopup />
            {/* Callback reminders. Mounted in the shell so a due callback reaches the
                rep wherever they are in the CRM, not only on the pages that list
                callbacks — and keeps coming back until they act on it. */}
            <CallbackReminders />
            {/* Global search + jump, on Ctrl/Cmd+K. Mounted here so it works from
                every page rather than only where a search box happens to render. */}
            <CommandPalette />
          </>
        )}
      </div>
      </PageTabsProvider>
    </CallProvider>
    </DisplaySettingsProvider>
  );
}
