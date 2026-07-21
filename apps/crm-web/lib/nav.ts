import {
  LayoutGrid,
  Activity,
  Headphones,
  Target,
  CircleCheckBig,
  GitBranch,
  Clock,
  PhoneCall,
  NotebookPen,
  SquareKanban,
  Calendar,
  Map,
  Bot,
  Plug,
  Shield,
  SlidersHorizontal,
  Settings,
  MessageSquare,
  Video,
  type LucideIcon,
} from 'lucide-react';

export type Role = 'admin' | 'team_leader' | 'employee';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  sub?: string;
  /** Roles allowed to see/visit this item. Omitted = all roles. */
  roles?: Role[];
  /**
   * Kept out of the sidebar, but still the route's entry here: the page stays
   * reachable by URL and keeps the title, subtitle and role rule this item
   * carries. Dropping the entry instead would leave the page titled "Ranger CRM".
   */
  hidden?: boolean;
}

export interface NavGroup {
  heading: string;
  items: NavItem[];
}

const MANAGERS: Role[] = ['admin', 'team_leader'];
const ADMIN: Role[] = ['admin'];

// Exact Ranger CRM menu — groups, labels, order.
export const NAV: NavGroup[] = [
  {
    heading: 'Operations',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutGrid, sub: 'Operations overview' },
      { label: 'Performance', href: '/productivity', icon: Activity, sub: 'Team productivity', roles: MANAGERS },
      { label: 'Live Team', href: '/manager', icon: Headphones, sub: 'Real-time floor status', roles: MANAGERS },
    ],
  },
  {
    heading: 'Pipeline',
    items: [
      { label: 'Lead Management', href: '/leads', icon: Target, sub: 'Active lead database' },
      { label: 'Closed Leads', href: '/closed-leads', icon: CircleCheckBig, sub: 'Leads marked closed' },
      { label: 'Sales Pipeline', href: '/pipeline', icon: GitBranch, sub: 'Deals by stage' },
      { label: 'Follow-Ups', href: '/followups', icon: Clock, sub: 'Callbacks & reminders', roles: MANAGERS },
    ],
  },
  {
    heading: 'Calling',
    items: [
      { label: 'Calling Panel', href: '/calling', icon: PhoneCall, sub: 'Dialer workspace' },
      { label: 'Zoom Meetings', href: '/zoom', icon: Video, sub: 'Schedule & meeting history' },
      { label: 'Outcome', href: '/outcomes', icon: NotebookPen, sub: 'Outcome status records', hidden: true },
      { label: 'Activity Tracker', href: '/activity', icon: NotebookPen, sub: 'Call activity log' },
      { label: 'Communications', href: '/communications', icon: MessageSquare, sub: 'Calls & SMS analytics', roles: MANAGERS },
    ],
  },
  {
    heading: 'Workspace',
    items: [
      { label: 'Tasks', href: '/tasks', icon: SquareKanban, sub: 'Personal task board' },
      { label: 'Calendar', href: '/calendar', icon: Calendar, sub: 'Calls & meetings' },
      { label: 'Territory Map', href: '/territories', icon: Map, sub: 'State coverage' },
    ],
  },
  {
    heading: 'AI & Admin',
    items: [
      { label: 'AI Training', href: '/ai-training', icon: Bot, sub: 'Knowledge base & coaching', roles: MANAGERS },
      { label: 'Integrations', href: '/integrations', icon: Plug, sub: 'Calling platforms', roles: ADMIN },
      { label: 'User Management', href: '/users', icon: Shield, sub: 'Users & roles', roles: ADMIN },
      { label: 'Admin Panel', href: '/admin', icon: SlidersHorizontal, sub: 'System administration', roles: ADMIN },
      { label: 'Settings', href: '/settings', icon: Settings, sub: 'Profile & preferences' },
    ],
  },
];

const FLAT = NAV.flatMap((g) => g.items);

function match(pathname: string): NavItem | undefined {
  let best: NavItem | undefined;
  for (const item of FLAT) {
    if (pathname === item.href || pathname.startsWith(item.href + '/')) {
      if (!best || item.href.length > best.href.length) best = item;
    }
  }
  return best;
}

export function titleForPath(pathname: string): string {
  return match(pathname)?.label ?? 'Ranger CRM';
}

export function subForPath(pathname: string): string {
  return match(pathname)?.sub ?? '';
}

// ── Role-based access (RBAC) ──
// Restricted route prefixes not represented in the nav (still reachable by URL).
const EXTRA_ROUTE_ROLES: { prefix: string; roles: Role[] }[] = [
  { prefix: '/analytics', roles: MANAGERS },
  { prefix: '/targets', roles: MANAGERS },
  { prefix: '/assignments', roles: MANAGERS },
  // Dropped from the nav (lead assignment lives in Lead Management now), but the
  // page and its workflows still work by URL — so it keeps its manager-only rule
  // here. Without this the route would fall through to "open to every role".
  { prefix: '/assigned', roles: MANAGERS },
  { prefix: '/security', roles: MANAGERS },
  { prefix: '/call-summary', roles: MANAGERS },
  { prefix: '/import', roles: MANAGERS },
  // /outcomes is open to all roles — the API scopes employees to their own
  // outcomes, while admins/team-leaders see everyone plus the User filter.
];

// All access rules (nav-derived + extras), longest-prefix wins.
const RULES: { prefix: string; roles: Role[] }[] = [
  ...FLAT.filter((i) => i.roles).map((i) => ({ prefix: i.href, roles: i.roles! })),
  ...EXTRA_ROUTE_ROLES,
];

/** Whether a role may visit a path. Unlisted paths are open to all roles. */
export function canAccessPath(pathname: string, role: Role | undefined): boolean {
  const rule = RULES
    .filter((r) => pathname === r.prefix || pathname.startsWith(r.prefix + '/'))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!rule) return true;
  return !!role && rule.roles.includes(role);
}

/** Nav filtered to a role — items the role can see, dropping empty groups.
 *  Hidden items are never listed, whatever the role. */
export function navForRole(role: Role | undefined): NavGroup[] {
  return NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => !i.hidden && (!i.roles || (role && i.roles.includes(role)))),
  })).filter((g) => g.items.length > 0);
}
