'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, MutationCache } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/toaster';
import { toast } from '@/lib/toast';

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
  const [client] = useState(
    () =>
      new QueryClient({
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
      }),
  );
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <QueryClientProvider client={client}>
        {children}
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
