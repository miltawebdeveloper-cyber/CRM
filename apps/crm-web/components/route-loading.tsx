import { Loader2 } from 'lucide-react';

/**
 * What the content area shows while the next page is on its way — the
 * `loading.tsx` of every route in the app shell.
 *
 * Without a loading boundary the App Router keeps the OLD page on screen until
 * the new one is ready, and the URL and the sidebar's highlight wait with it,
 * so a click on anything not already prefetched (a lead's own page, a Zoom
 * meeting, any page in `next dev`) looked like it had done nothing. With one,
 * the router commits the navigation at once: the address bar and the active
 * menu item move on the click, and this shows in the content area while the
 * sidebar and top bar stay put.
 *
 * Invisible for its first 200ms (`.route-loading`, globals.css), so a fast
 * navigation never flashes it — it only appears when there is a wait worth
 * acknowledging.
 */
export function RouteLoading() {
  return (
    <div role="status" aria-live="polite" className="route-loading grid h-[40vh] place-items-center">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    </div>
  );
}
