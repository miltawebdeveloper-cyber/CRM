'use client';

import { useQuery } from '@tanstack/react-query';
import { outcomesApi, type Outcome } from '@/lib/crm';

/**
 * Resolve an outcome SLUG to the name and colour an admin configured for it.
 *
 * Calls, leads and activity rows all store the slug (`dm_not_interested`), not
 * the label. Anything that renders one raw is showing a database key to a user:
 * the activity log printed "dm not interested" and the Activity Tracker's pill
 * managed "Dm Not_interested", because it replaced only the FIRST underscore.
 * Neither matches "Dm-Not Interested", which is what the outcome is actually
 * called and what every other module displays.
 *
 * The name comes from the configured list (Admin → Outcomes) rather than a
 * hard-coded map, so renaming an outcome renames it everywhere at once — the
 * whole point of the outcomes being configurable.
 *
 * `label` falls back to a humanised slug for values that are NOT outcomes: the
 * same columns carry lead statuses, field edits and plain booleans, and those
 * must still read sensibly.
 */
export function useOutcomeLabels() {
  // Same query key the other outcome consumers use, so this shares their cache
  // rather than adding a request per view.
  const { data: outcomes = [] } = useQuery<Outcome[]>({
    queryKey: ['outcomes-config'],
    queryFn: outcomesApi.list,
    // Rarely changes, and every row on screen asks for it.
    staleTime: 5 * 60_000,
    retry: false,
  });

  const bySlug = new Map(outcomes.map((o) => [o.slug, o]));

  return {
    outcomes,
    /** The configured outcome for a slug, or undefined when it isn't one. */
    outcome: (slug?: string | null) => (slug ? bySlug.get(slug) : undefined),
    /**
     * Display text for a value that MAY be an outcome slug. Falls back to the
     * humanised value — every underscore, not just the first — so a lead status
     * or a field edit still reads as words rather than as a key.
     */
    label: (value?: string | null) => {
      if (!value) return '';
      return bySlug.get(value)?.name ?? value.replace(/_/g, ' ');
    },
  };
}
