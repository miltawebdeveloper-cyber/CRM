'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api, tokenStore } from '@/lib/api';
import { canAccessPath, type Role } from '@/lib/nav';
import { Sidebar } from '@/components/sidebar';
import { Topbar } from '@/components/topbar';
import { IncomingCallPopup } from '@/components/incoming-call';
import { CallbackReminders } from '@/components/callback-reminder';
import { CommandPalette } from '@/components/command-palette';
import { SessionGuard } from '@/components/session-guard';
import { CallProvider } from '@/components/call-provider';
import { PageTabsProvider } from '@/components/page-tabs';
import { DisplaySettingsProvider } from '@/components/display-settings-provider';

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
    if (!tokenStore.access) router.replace('/login');
  }, [router]);

  // Reset the scroll container to top on navigation (Next scrolls window, not <main>).
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  const {
    data: me,
    isPending: mePending,
    isError: meErrored,
    refetch: refetchMe,
  } = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get('/auth/me')).data,
    retry: false,
  });

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
