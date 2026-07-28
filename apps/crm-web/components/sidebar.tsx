'use client';

import { Fragment } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { api } from '@/lib/api';
import { navForRole, type NavItem, type Role } from '@/lib/nav';
import { usePersistedState } from '@/lib/use-persisted-state';
import { cn } from '@/lib/utils';

function ShieldMark() {
  return (
    <div
      className="grid h-9 w-9 place-items-center rounded-[9px]"
      style={{
        background: 'linear-gradient(150deg,#7e9933,#1d491f)',
        boxShadow: 'inset 0 0 0 1.5px rgba(255,255,255,.14)',
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" className="h-[21px] w-[21px]">
        <path d="M12 2L3 6v6c0 5 3.8 8.6 9 10 5.2-1.4 9-5 9-10V6l-9-4z" fill="#d8eed9" />
        <path
          d="M9.5 12l1.8 1.8 3.5-3.6"
          stroke="#266929"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/**
 * A nav row.
 *
 * `collapsed` narrows the row to an icon rail — but ONLY from `lg` up. Below that
 * the sidebar is a drawer the user deliberately opened, where there is plenty of
 * width and an icon-only menu would be worse, not better. Doing that split in CSS
 * rather than by measuring the viewport keeps the server and client markup
 * identical, so there is no hydration flicker.
 */
function NavLink({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      // Closes the drawer on the tap that navigates, rather than reacting to the
      // path changing afterwards — the close belongs to the click that caused it,
      // and doing it here avoids a render pass that sets state from an effect.
      onClick={onNavigate}
      // On the rail the icon is the only label there is, so the name moves to the
      // tooltip and the accessible name. Harmless in the drawer, where the text
      // is visible and says the same thing.
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        // Height comes from the flex basis, not padding: the row sits at its full
        // 38px when there's room and gives height back when there isn't, so the
        // menu fits the window instead of scrolling out of it.
        'relative mb-0.5 flex min-h-[22px] shrink basis-[38px] items-center gap-[11px] rounded-[9px] px-3 text-[13.5px] font-medium transition-colors',
        collapsed && 'lg:justify-center lg:gap-0 lg:px-0',
        active ? 'bg-[#266929] text-white shadow-sm' : 'text-[#c7d69f] hover:bg-white/[.06] hover:text-white',
      )}
    >
      <Icon className={cn('h-[18px] w-[18px] shrink-0', active ? 'opacity-100' : 'opacity-85')} />
      <span className={cn('flex-1 truncate', collapsed && 'lg:hidden')}>{item.label}</span>
    </Link>
  );
}

export function Sidebar({ mobileOpen = false, onClose }: { mobileOpen?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  // Persisted, so a rep who prefers the rail keeps it across navigation and
  // reloads rather than re-collapsing it on every page.
  const [collapsed, setCollapsed] = usePersistedState('sidebar:collapsed', false);
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get('/auth/me')).data,
    retry: false,
  });

  const isActive = (href: string) =>
    href === '/dashboard' ? pathname === href : pathname === href || pathname.startsWith(href + '/');

  const name: string = me?.name ?? me?.email?.split('@')[0] ?? 'User';
  const initials = name
    .split(/[ .@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s: string) => s[0]?.toUpperCase())
    .join('');
  const role = (me?.role ?? '').replace('_', ' ');
  const nav = navForRole(me?.role as Role | undefined);

  return (
    <>
      {/* Scrim behind the drawer. Only below `lg`, where the sidebar overlays the
          page — at `lg` it's a column and there is nothing to dismiss. */}
      {mobileOpen && (
        <div
          onClick={onClose}
          aria-hidden
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
        />
      )}

      <aside
        className={cn(
          'flex h-screen shrink-0 flex-col overflow-hidden text-[#d8eed9]',
          // Below `lg`: an off-canvas drawer, slid out of view until opened. At
          // `lg` and up: back to a normal sticky column, always on screen.
          'fixed inset-y-0 left-0 z-50 w-[268px] max-w-[85vw] transition-transform duration-200 ease-out',
          mobileOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full',
          'lg:sticky lg:top-0 lg:z-auto lg:max-w-none lg:translate-x-0 lg:shadow-none lg:transition-[width]',
          // The collapse rail is a desktop affordance only — see NavLink.
          collapsed ? 'lg:w-[68px]' : 'lg:w-[248px]',
        )}
        style={{ background: 'linear-gradient(177deg,#163618,#112712)' }}
      >
        {/* Head — brand lockup, the collapse control (desktop) and the drawer's
            close button (mobile). Railed, the row becomes a centred column with
            the toggle under the mark: there isn't width for both side by side. */}
        <div className={cn('border-b border-white/[.07] px-[18px] pb-[14px] pt-[18px]', collapsed && 'lg:px-0')}>
          <div className={cn('flex items-center gap-[11px]', collapsed && 'lg:flex-col lg:gap-2')}>
            <ShieldMark />
            <div
              className={cn(
                'font-display text-[18px] font-semibold leading-none tracking-tight text-white',
                collapsed && 'lg:hidden',
              )}
            >
              Milta
              <small className="mt-[2px] block text-[9.5px] font-medium uppercase tracking-[.22em] text-[#7e9933]">
                Sales CRM
              </small>
            </div>
            {/* Collapse to a rail — desktop only. In the drawer the way out is
                Close, and an icon-only drawer would defeat opening it. */}
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              aria-expanded={!collapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className={cn(
                'hidden h-8 w-8 shrink-0 place-items-center rounded-[9px] text-[#c7d69f] transition-colors hover:bg-white/[.08] hover:text-white lg:grid',
                !collapsed && 'ml-auto',
              )}
            >
              {collapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
            </button>
            {/* Close the drawer — mobile only. */}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close menu"
              className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-[9px] text-[#c7d69f] transition-colors hover:bg-white/[.08] hover:text-white lg:hidden"
            >
              <X className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>

        {/* Nav — the rows are this container's flex children rather than each group
          being one, so the whole menu shares the leftover height and shrinks as a
          single list to fit the window. Headings hold their size; only rows give.
          If a window is short enough that even the minimum row won't fit, it
          scrolls as a last resort — without a scrollbar, since a light track down
          the dark rail reads as part of the chrome. */}
        <nav
          className={cn(
            'flex flex-1 flex-col overflow-y-auto px-3 pb-5 pt-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
            collapsed && 'lg:px-2.5',
          )}
        >
          {nav.map((group) => (
            <Fragment key={group.heading}>
              {/* On the rail a heading has nowhere to fit legibly, so the groups
                  are kept apart by a rule instead of losing the grouping — the
                  shape of the menu is what makes the icons findable. Both are
                  always rendered and swapped by breakpoint, so the drawer keeps
                  its headings while the desktop rail shows rules. */}
              <p
                className={cn(
                  'mt-4 shrink-0 px-3 pb-[5px] text-[10px] font-semibold uppercase tracking-[.16em] text-[#7e9933] first:mt-0',
                  collapsed && 'lg:hidden',
                )}
              >
                {group.heading}
              </p>
              {collapsed && (
                <hr className="mx-2 mt-3 hidden shrink-0 border-white/[.09] first:mt-0 first:border-0 lg:block" aria-hidden />
              )}
              {group.items.map((item) => (
                <NavLink key={item.href} item={item} active={isActive(item.href)} collapsed={collapsed} onNavigate={onClose} />
              ))}
            </Fragment>
          ))}
        </nav>

        {/* Foot — user. On the rail the avatar carries the name in its tooltip,
            so the link stays identifiable without the two lines of text. */}
        <div className={cn('border-t border-white/[.07] p-3', collapsed && 'lg:p-2')}>
          <Link
            href="/settings"
            onClick={onClose}
            title={collapsed ? `${name}${role ? ` · ${role}` : ''}` : undefined}
            aria-label={collapsed ? `${name} — account settings` : undefined}
            className={cn(
              'flex items-center gap-[10px] rounded-[10px] p-2 transition-colors hover:bg-white/[.06]',
              collapsed && 'lg:justify-center lg:gap-0',
            )}
          >
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#2b732f] font-display text-[13px] font-semibold text-white">
              {initials || 'U'}
            </div>
            <div className={cn('overflow-hidden leading-tight', collapsed && 'lg:hidden')}>
              <div className="truncate text-[13px] font-semibold text-white">{name}</div>
              <div className="text-[11px] capitalize text-[#a6c74d]">{role || 'Member'}</div>
            </div>
          </Link>
        </div>
      </aside>
    </>
  );
}
