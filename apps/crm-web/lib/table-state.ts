/**
 * What a data grid should be showing right now.
 *
 * One function, in `lib` and under test, because this is the rule the whole
 * "leads keep disappearing" class of bug lived in. The grid used to decide it
 * inline as `loading ? <spinner> : rows.map(...)`, and that reads as harmless
 * until you notice what it means: a request in flight REPLACES the rows, so
 * every filter change, every re-sort, every keystroke past the search debounce
 * and every refetch after a save emptied a full table and refilled it a second
 * later. Nothing was wrong with the data. The grid simply stopped showing it.
 *
 * Stated as a decision, the rule is short enough to be obviously right:
 *
 *   • Rows exist        → show them. Always. A request in flight is a reason to
 *                         say "updating", never a reason to show less.
 *   • No rows, busy     → show the placeholder. This is the ONLY case that may
 *                         legitimately show no rows and no explanation.
 *   • No rows, idle     → show the empty state, which is now a claim the grid is
 *                         entitled to make: nothing is on its way.
 */
export type GridState = 'rows' | 'placeholder' | 'empty';

export function gridState(input: {
  /** First load — there has never been anything to show. */
  loading?: boolean;
  /** A refresh over rows that already exist, or rows held from the previous query. */
  refreshing?: boolean;
  rowCount: number;
}): GridState {
  if (input.rowCount > 0) return 'rows';
  return input.loading || input.refreshing ? 'placeholder' : 'empty';
}

/** True while newer data is on its way — drives the "updating" hairline. */
export function isGridBusy(input: { loading?: boolean; refreshing?: boolean }): boolean {
  return !!input.loading || !!input.refreshing;
}
