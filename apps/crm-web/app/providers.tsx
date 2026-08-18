'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, MutationCache } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/toaster';
import { toast } from '@/lib/toast';
import { markAppHydrated } from '@/lib/hydration';

// Per-mutation opt-ins read by the shared handler below.
declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /** Toast shown on success (opt-in). */
      successMessage?: string;
      /** Overrides the auto-extracted error message. */
      errorMessage?: string;
      /** Skip the global error toast (mutation shows its own inline error). */
      suppressErrorToast?: boolean;
    };
  }
}

/** Pull a human message out of an axios/API error, with a sane fallback. */
function errorMessage(err: unknown): string {
  const res = (err as { response?: { data?: { message?: unknown } } })?.response;
  const m = res?.data?.message;
  if (Array.isArray(m)) return String(m[0]);
  if (typeof m === 'string' && m) return m;
  const generic = (err as { message?: string })?.message;
  return generic && generic !== 'Network Error' ? generic : 'Something went wrong. Please try again.';
}

export function Providers({ children }: { children: ReactNode }) {
  // One place decides how every mutation reports success/failure, so feedback is
  // consistent app-wide. Mutations opt into a success toast via `meta`.
  const [client] = useState(() => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: {
          /**
           * Data was treated as stale the moment it arrived, so every mount
           * and every window focus went back to the network — moving between
           * two pages and back re-fetched rows that were seconds old, and a
           * tab regaining focus refetched all of them at once.
           *
           * Half a minute of trust instead. It costs nothing in freshness
           * where it matters: the live views drive themselves on
           * `refetchInterval`, which ignores this, and the 27 files that
           * `invalidateQueries` after a mutation still refetch immediately —
           * invalidation marks data stale regardless of this setting. What it
           * removes is the re-fetching of things nobody changed.
           */
          staleTime: 30_000,
          /**
           * Off by default because the one query that genuinely wants it —
           * the dashboard summary — asks for it explicitly. Every other query
           * was paying for a refetch storm on tab focus without ever having
           * requested one.
           */
          refetchOnWindowFocus: false,
        },
      },
      mutationCache: new MutationCache({
        onSuccess: (_data, _vars, _ctx, mutation) => {
          const msg = mutation.meta?.successMessage;
          if (msg) toast.success(msg);
        },
        onError: (err, _vars, _ctx, mutation) => {
          if (mutation.meta?.suppressErrorToast) return;
          toast.error(mutation.meta?.errorMessage ?? errorMessage(err));
        },
      }),
    });

    /**
     * Per-key freshness, decided once instead of at each of the call sites.
     *
     * Some of these are asked for by many components at once — `/auth/me` alone
     * has fourteen callers — and each stated its own options, or none. React
     * Query takes the SHORTEST staleTime among the observers of a key, so one
     * caller leaving it at the default pulled the whole key back to it, and
     * moving between pages re-fetched an account and a settings row that change
     * perhaps once a month. Setting it against the key covers every caller,
     * present and future, without touching them.
     */
    // Who is signed in, and what they may do. Changes on a re-login, which
    // replaces the cache wholesale.
    qc.setQueryDefaults(['me'], { staleTime: 5 * 60_000, gcTime: 30 * 60_000, retry: false });
    // Admin-configured lists. Read by the filter bars, the outcome cells and the
    // Calling Panel, edited rarely and invalidated explicitly when they are.
    qc.setQueryDefaults(['outcomes-config'], { staleTime: 10 * 60_000, gcTime: 30 * 60_000 });
    qc.setQueryDefaults(['calling-mode'], { staleTime: 60_000 });
    /**
     * How long a lead list survives after the last screen showing it unmounts.
     *
     * The default is five minutes, after which the entry is collected and coming
     * back to Lead Management starts from an empty grid — which is precisely the
     * "leads vanish when I navigate" report, arriving on a delay long enough
     * that it looked random. Twenty minutes covers a normal round trip through
     * the CRM, so returning to the module paints the rows immediately and
     * refreshes them behind the paint.
     */
    qc.setQueryDefaults(['leads'], { gcTime: 20 * 60_000 });

    return qc;
  });

  // Everything mounted after this point is a client-side navigation and may read
  // localStorage during its first render. See `lib/hydration`.
  useEffect(() => {
    markAppHydrated();
  }, []);

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <QueryClientProvider client={client}>
        {children}
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
