'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api, tokenStore } from '@/lib/api';
import { canAccessPath, type Role } from '@/lib/nav';
import { Sidebar } from '@/components/sidebar';
import { Topbar } from '@/components/topbar';
import { IncomingCallPopup } from '@/components/incoming-call';
import { CallProvider } from '@/components/call-provider';
import { PageTabsProvider } from '@/components/page-tabs';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!tokenStore.access) router.replace('/login');
  }, [router]);

  // Reset the scroll container to top on navigation (Next scrolls window, not <main>).
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  const { data: me } = useQuery({
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
    <CallProvider>
      {/* Wraps the topbar and the page together, so a page can render its view
          tabs into the slot the topbar exposes beside the title. */}
      <PageTabsProvider>
      <div className="flex h-screen overflow-hidden bg-background">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar email={me?.email} />
          <main ref={mainRef} className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1500px] p-6">
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
        <IncomingCallPopup />
      </div>
      </PageTabsProvider>
    </CallProvider>
  );
}
