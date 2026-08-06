'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Search, Phone, Settings, LogOut, Menu } from 'lucide-react';
import { tokenStore } from '@/lib/api';
import { availabilityApi } from '@/lib/availability';
import { ThemeToggle } from '@/components/theme-toggle';
import { NotificationBell } from '@/components/notification-bell';
import { PageTabsSlot, useHasPageTabs } from '@/components/page-tabs';
import { openCommandPalette, useShortcutHint } from '@/components/command-palette';
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

export function Topbar({ email, onMenu }: { email?: string; onMenu?: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const shortcutHint = useShortcutHint();
  const openPalette = openCommandPalette;

  const title = titleForPath(pathname);
  const sub = subForPath(pathname);
  const hasTabs = useHasPageTabs();
  const initial = (email ?? 'U').charAt(0).toUpperCase();

  async function logout() {
    // Flip status to offline before the token is cleared (best-effort).
    try { await availabilityApi.signOut(); } catch { /* ignore */ }
    tokenStore.clear();
    // A full navigation, not `router.replace`. A client-side push keeps the
    // React Query cache alive across the sign-out, so the next person to sign in
    // on this browser rendered the PREVIOUS user's cached `me` — their email in
    // this bar, their role deciding what the menu offered — until each query
    // refetched. Leaving the page drops that cache with the session.
    window.location.href = '/login';
  }

  return (
    <header className="sticky top-0 z-30 flex h-[62px] items-center gap-2 border-b bg-card/85 px-3 backdrop-blur sm:gap-4 sm:px-6">
      {/* Opens the nav drawer. Below `lg` the sidebar is off-canvas, so without
          this there is no way to reach the menu at all. */}
      <button
        type="button"
        onClick={onMenu}
        aria-label="Open menu"
        className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] text-[#1d491f] transition-colors hover:bg-muted dark:text-foreground/80 lg:hidden"
      >
        <Menu className="h-[21px] w-[21px]" />
      </button>

      {/* Page title + subtitle. A page with tabs names itself in its first tab,
          so the title stands down rather than repeating the same word.
          `min-w-0` + truncate so a long title yields rather than shoving the
          actions off a narrow screen. */}
      {!hasTabs && (
        <div className="min-w-0">
          <div className="truncate font-display text-[18px] font-semibold leading-tight tracking-tight">{title}</div>
          {sub && <div className="truncate text-[11.5px] text-muted-foreground">{sub}</div>}
        </div>
      )}

      {/* Where a page hangs its view tabs. Empty on pages that don't have any.
          Scrolls sideways rather than wrapping — the Calling Panel has six, which
          will not fit a phone, and a wrapped second row would push the bar's
          height around as you navigate. */}
      <PageTabsSlot className="min-w-0 max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" />

      {/* Search — opens the command palette.
          This was a real <input> that searched nothing: it had no value binding,
          and submitting it navigated to Lead Management whatever you typed, while
          advertising a ⌘K shortcut nothing listened for. A button that opens the
          palette is honest about what it does, and the palette is where the
          searching actually happens (see components/command-palette.tsx). */}
      <button
        type="button"
        onClick={openPalette}
        aria-label="Search leads or jump to a module"
        className="ml-2 hidden max-w-[420px] flex-1 items-center gap-[9px] rounded-md border bg-background px-[13px] py-2 text-left transition-colors hover:border-primary md:flex"
      >
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-sm text-muted-foreground">Search leads, contacts, calls…</span>
        <kbd className="shrink-0 rounded border bg-card px-1.5 font-mono text-[10.5px] text-muted-foreground">
          {shortcutHint}
        </kbd>
      </button>

      {/* Same thing on a phone, where the full bar has no room. */}
      <button
        type="button"
        onClick={openPalette}
        aria-label="Search"
        className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] text-[#1d491f] transition-colors hover:bg-muted dark:text-foreground/80 md:hidden"
      >
        <Search className="h-[19px] w-[19px]" />
      </button>

      <div className="flex-1" />

      {/* Actions. Quick dial and Settings are both one tap away in the nav
          drawer, so they stand down on a phone rather than crowding out the
          notification bell and the account menu, which are not. */}
      <div className="hidden sm:contents">
        <IconBtn label="Quick dial" href="/calling">
          <Phone className="h-[19px] w-[19px]" />
        </IconBtn>
      </div>
      <NotificationBell />
      <div className="hidden sm:contents">
        <IconBtn label="Settings" href="/settings">
          <Settings className="h-[19px] w-[19px]" />
        </IconBtn>
      </div>
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
