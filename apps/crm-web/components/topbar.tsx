'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Search, Phone, Settings, LogOut } from 'lucide-react';
import { tokenStore } from '@/lib/api';
import { availabilityApi } from '@/lib/availability';
import { ThemeToggle } from '@/components/theme-toggle';
import { NotificationBell } from '@/components/notification-bell';
import { PageTabsSlot, useHasPageTabs } from '@/components/page-tabs';
import { titleForPath, subForPath } from '@/lib/nav';

function IconBtn({ children, label, href, onClick }: { children: React.ReactNode; label: string; href?: string; onClick?: () => void }) {
  const cls =
    'relative grid h-[38px] w-[38px] place-items-center rounded-[10px] text-[#1d491f] transition-colors hover:bg-muted dark:text-foreground/80';
  if (href)
    return (
      <Link href={href} aria-label={label} title={label} className={cls}>
        {children}
      </Link>
    );
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

export function Topbar({ email }: { email?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const title = titleForPath(pathname);
  const sub = subForPath(pathname);
  const hasTabs = useHasPageTabs();
  const initial = (email ?? 'U').charAt(0).toUpperCase();

  async function logout() {
    // Flip status to offline before the token is cleared (best-effort).
    try { await availabilityApi.signOut(); } catch { /* ignore */ }
    tokenStore.clear();
    router.replace('/login');
  }

  return (
    <header className="sticky top-0 z-40 flex h-[62px] items-center gap-4 border-b bg-card/85 px-6 backdrop-blur">
      {/* Page title + subtitle. A page with tabs names itself in its first tab,
          so the title stands down rather than repeating the same word. */}
      {!hasTabs && (
        <div className="shrink-0">
          <div className="font-display text-[18px] font-semibold leading-tight tracking-tight">{title}</div>
          {sub && <div className="text-[11.5px] text-muted-foreground">{sub}</div>}
        </div>
      )}

      {/* Where a page hangs its view tabs. Empty on pages that don't have any. */}
      <PageTabsSlot className="shrink-0" />

      {/* Search */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          router.push('/leads');
        }}
        className="ml-2 hidden max-w-[420px] flex-1 items-center gap-[9px] rounded-md border bg-background px-[13px] py-2 transition-colors focus-within:border-primary md:flex"
      >
        <Search className="h-4 w-4 text-muted-foreground" />
        <input
          placeholder="Search leads, contacts, calls…"
          className="flex-1 border-none bg-transparent text-sm outline-none"
        />
        <kbd className="rounded border bg-card px-1.5 font-mono text-[10.5px] text-muted-foreground">⌘K</kbd>
      </form>

      <div className="flex-1" />

      {/* Actions */}
      <IconBtn label="Quick dial" href="/calling">
        <Phone className="h-[19px] w-[19px]" />
      </IconBtn>
      <NotificationBell />
      <IconBtn label="Settings" href="/settings">
        <Settings className="h-[19px] w-[19px]" />
      </IconBtn>
      <ThemeToggle />

      {/* Avatar */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="grid h-9 w-9 place-items-center rounded-full bg-primary font-display text-sm font-semibold text-primary-foreground"
        >
          {initial}
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 z-20 mt-2 w-56 rounded-md border bg-card p-1 shadow-lg">
              <div className="border-b px-3 py-2 text-sm text-muted-foreground">{email}</div>
              <button onClick={logout} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted">
                <LogOut className="h-4 w-4" /> Logout
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
