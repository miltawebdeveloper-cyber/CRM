import type { QueryClient } from '@tanstack/react-query';
import { activitiesApi, callsApi, configApi, integrationsApi, metricsApi, notificationsApi, openphoneApi, tasksApi } from '@/lib/crm';
import { usersApi } from '@/lib/users';

/**
 * What to fetch when a nav row is hovered, so the page has its data before the
 * click lands.
 *
 * `next/link` already prefetches route JAVASCRIPT on hover, which is why
 * navigation rarely waits on code. It waits on data: every page here is a
 * client component, so it mounts and only THEN starts asking. The gap between
 * a pointer arriving on a menu row and the click that follows is a couple of
 * hundred milliseconds of human time, and that is enough to cover most of these
 * requests.
 *
 * Only pages whose primary query depends on nothing the page itself holds are
 * listed. Most of the CRM's heavy screens — leads, analytics, the dashboard —
 * key their queries on filters and date ranges that live in page state, so
 * there is no way to ask for the right thing from out here; guessing would
 * warm a cache entry the page then ignores, which is worse than not trying.
 *
 * The keys and functions below must stay identical to the ones the pages use,
 * or the prefetch quietly warms an entry nobody reads. They are duplicated
 * rather than shared because the pages own their queries; if one of them
 * changes key, delete its line here.
 */
export const NAV_PREFETCH: Record<string, (qc: QueryClient) => void> = {
  '/tasks': (qc) => void qc.prefetchQuery({ queryKey: ['tasks'], queryFn: tasksApi.list }),
  '/users': (qc) => void qc.prefetchQuery({ queryKey: ['users'], queryFn: usersApi.list }),
  '/activity': (qc) => void qc.prefetchQuery({ queryKey: ['activities'], queryFn: activitiesApi.list }),
  '/notifications': (qc) => void qc.prefetchQuery({ queryKey: ['notifications'], queryFn: notificationsApi.list }),
  '/outcomes': (qc) => void qc.prefetchQuery({ queryKey: ['outcomes'], queryFn: () => callsApi.outcomes() }),
  // Aggregate lead counts per state — a choropleth, not an individually
  // actionable record, so a few seconds' staleness at first paint costs
  // nothing the page's own 15s poll doesn't already accept.
  '/territories': (qc) => void qc.prefetchQuery({ queryKey: ['m-states'], queryFn: () => metricsApi.byState() }),
  // All three feed the page's one (default, untabbed) view — no gate to warm
  // past.
  '/integrations': (qc) => {
    void qc.prefetchQuery({ queryKey: ['config-status'], queryFn: configApi.status });
    void qc.prefetchQuery({ queryKey: ['integrations-status'], queryFn: integrationsApi.status });
    void qc.prefetchQuery({ queryKey: ['openphone-status'], queryFn: openphoneApi.status });
  },
  // Same: KPI row + activity log, no tabs, nothing gated behind a click.
  // `activities`/`users` are the same cache entries `/activity` and `/users`
  // above already warm — repeated here so hovering Admin directly still gets
  // them, not because they're a second, different fetch.
  '/admin': (qc) => {
    void qc.prefetchQuery({ queryKey: ['activities'], queryFn: activitiesApi.list });
    void qc.prefetchQuery({ queryKey: ['users'], queryFn: usersApi.list });
    void qc.prefetchQuery({ queryKey: ['metrics', 'summary'], queryFn: () => metricsApi.summary() });
  },
};

/**
 * Warm the data for `href`, if there is anything worth warming.
 *
 * Safe to call on every hover: `prefetchQuery` honours `staleTime`, so a row
 * the pointer crosses repeatedly costs one request per staleness window rather
 * than one per pass, and a failure is swallowed — a prefetch that does not
 * arrive must never surface as an error on a page the user has not opened.
 */
export function prefetchRoute(qc: QueryClient, href: string) {
  try {
    NAV_PREFETCH[href]?.(qc);
  } catch {
    /* the page will fetch it properly on mount */
  }
}
