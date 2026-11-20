/** @jest-environment jsdom */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The role gate's own regression, not the sidebar/topbar's.
 *
 * `AppLayout` used to destructure only `data` from `useQuery(['me'])`, so while
 * that request was still in flight `role` was `undefined` and
 * `allowed = !role || canAccessPath(...)` evaluated true — protected content
 * rendered immediately, before the real role was known. Every consumer that
 * cares about role (Sidebar, Topbar, the page itself) reads the same `['me']`
 * cache entry, so this is the one place that needs to gate: prove it does.
 *
 * Child components are stubbed to isolate the gate's own logic from whatever
 * Sidebar/Topbar/CommandPalette/etc. do internally — this test is about
 * whether AppLayout shows them (and `children`) before or after `['me']`
 * resolves, not about what they render once it has.
 */

jest.mock('@/lib/preferences', () => ({
  loadServerPreferences: async () => ({}),
  saveServerPreference: jest.fn(),
  removeServerPreference: jest.fn(),
}));

// Mutable so the scroll tests can navigate; every other test stays on /dashboard.
let mockPathname = '/dashboard';
jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), prefetch: jest.fn() }),
}));

const getMock = jest.fn();
jest.mock('@/lib/api', () => ({
  api: { get: (...args: unknown[]) => getMock(...args) },
  tokenStore: { access: 'fake-access-token' },
}));

jest.mock('@/components/sidebar', () => ({ Sidebar: () => <div data-testid="sidebar-stub">Sidebar</div> }));
jest.mock('@/components/topbar', () => ({ Topbar: () => <div data-testid="topbar-stub">Topbar</div> }));
jest.mock('@/components/incoming-call', () => ({ IncomingCallPopup: () => null }));
jest.mock('@/components/callback-reminder', () => ({ CallbackReminders: () => null }));
jest.mock('@/components/command-palette', () => ({ CommandPalette: () => null }));
jest.mock('@/components/session-guard', () => ({ SessionGuard: () => null }));

import AppLayout from './layout';

/** A promise this test can resolve/reject on its own schedule. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderLayout() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AppLayout>
        <div data-testid="page-content">Protected page content</div>
      </AppLayout>
    </QueryClientProvider>,
  );
}

describe('AppLayout role gate', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('shows a neutral loading state, and nothing role-gated, while /auth/me is pending', async () => {
    const { promise } = deferred<{ data: { id: string; email: string; role: string } }>();
    getMock.mockReturnValue(promise);

    renderLayout();
    // Lets DisplaySettingsProvider's own (unrelated) preference-load microtask
    // settle before asserting, so its state update isn't flagged as outside act().
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText('Loading your workspace…')).toBeDefined();
    expect(screen.queryByTestId('sidebar-stub')).toBeNull();
    expect(screen.queryByTestId('topbar-stub')).toBeNull();
    expect(screen.queryByTestId('page-content')).toBeNull();
  });

  it('renders the shell and the page only after /auth/me resolves', async () => {
    const { promise, resolve } = deferred<{ data: { id: string; email: string; role: string } }>();
    getMock.mockReturnValue(promise);

    renderLayout();
    expect(screen.queryByTestId('page-content')).toBeNull();

    resolve({ data: { id: 'u1', email: 'employee@crm.local', role: 'employee' } });

    await waitFor(() => expect(screen.queryByText('Loading your workspace…')).toBeNull());
    expect(screen.getByTestId('sidebar-stub')).toBeDefined();
    expect(screen.getByTestId('topbar-stub')).toBeDefined();
    expect(screen.getByTestId('page-content')).toBeDefined();
  });

  it('shows a retry state, and nothing role-gated, if /auth/me fails', async () => {
    const { promise, reject } = deferred<never>();
    getMock.mockReturnValue(promise);

    renderLayout();
    reject(new Error('network error'));

    await waitFor(() => expect(screen.getByText('Couldn’t load your account')).toBeDefined());
    expect(screen.queryByTestId('sidebar-stub')).toBeNull();
    expect(screen.queryByTestId('topbar-stub')).toBeNull();
    expect(screen.queryByTestId('page-content')).toBeNull();
  });
});

/**
 * The shell scrolls <main>, which Next's own scroll restoration doesn't know
 * about: a new navigation starts at the top, Back/Forward returns to where the
 * page was left.
 */
describe('AppLayout scroll position', () => {
  beforeEach(() => {
    getMock.mockReset();
    getMock.mockResolvedValue({ data: { id: 'u1', email: 'm@crm.local', role: 'admin' } } as never);
    mockPathname = '/leads';
    window.history.replaceState(null, '', '/leads');
  });

  /** jsdom has no layout, so give <main> a scrollTop that remembers what it's set to. */
  function trackScroll(main: HTMLElement) {
    let top = 0;
    Object.defineProperty(main, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });
    return {
      scrollTo(y: number) {
        top = y;
        main.dispatchEvent(new Event('scroll'));
      },
    };
  }

  it('starts a new page at the top and puts a Back where it was', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = () => (
      <QueryClientProvider client={qc}>
        <AppLayout>
          <div>{mockPathname}</div>
        </AppLayout>
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    const main = await screen.findByRole('main');
    const scroller = trackScroll(main);

    // Reading the list, 1,200px down.
    scroller.scrollTo(1200);

    // Open a lead — a new navigation, so the top of the page.
    mockPathname = '/leads/abc';
    window.history.pushState(null, '', '/leads/abc');
    act(() => rerender(tree()));
    expect(main.scrollTop).toBe(0);

    // Back to the list — where it was left.
    window.history.back = () => {};
    window.history.replaceState(null, '', '/leads');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    mockPathname = '/leads';
    act(() => rerender(tree()));
    expect(main.scrollTop).toBe(1200);

    // And an ordinary click afterwards starts at the top again.
    mockPathname = '/dashboard';
    window.history.pushState(null, '', '/dashboard');
    act(() => rerender(tree()));
    expect(main.scrollTop).toBe(0);
  });
});
