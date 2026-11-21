/**
 * Calls made against a rep's daily call target: "12 / 40".
 *
 * The target is the per-day figure set in Calls Made (Set target); 0 means none
 * is set, and then this is just the count — a "/ 0" would read as a target of
 * nothing. The "/ 40" is quieter than the count, and a screen reader hears
 * "12 of a daily target of 40" rather than "12 slash 40".
 */
export function CallsVsTarget({ calls, target }: { calls: number; target: number }) {
  if (!target || target <= 0) return <>{calls.toLocaleString()}</>;
  return (
    <span title={`${calls.toLocaleString()} of a daily target of ${target.toLocaleString()}`}>
      {calls.toLocaleString()}
      <span aria-hidden className="font-normal text-muted-foreground"> / {target.toLocaleString()}</span>
      <span className="sr-only"> of a daily target of {target.toLocaleString()}</span>
    </span>
  );
}
