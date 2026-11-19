import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export const ACCESS_KEY = 'crm.accessToken';
const REFRESH_KEY = 'crm.refreshToken';

export const tokenStore = {
  get access() {
    return typeof window !== 'undefined' ? localStorage.getItem(ACCESS_KEY) : null;
  },
  get refresh() {
    return typeof window !== 'undefined' ? localStorage.getItem(REFRESH_KEY) : null;
  },
  set(access: string, refresh: string) {
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

function decodeBase64Url(segment: string): string {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = pad ? normalized + '='.repeat(4 - pad) : normalized;
  return globalThis.atob(padded);
}

/** The account a JWT belongs to, or null when it can't be read. */
export function subjectOf(token: string | null | undefined): string | null {
  if (!token) return null;
  try {
    const body = token.split('.')[1] ?? '';
    if (!body) return null;
    const payload = JSON.parse(decodeBase64Url(body));
    return payload.sub ?? payload.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Requests where a 401 means "these credentials are wrong", NOT "the access
 * token has expired".
 *
 * Refreshing on those was how signing in could hand you somebody else's
 * account. `/auth/login` answers 401 for a wrong password, and the handler
 * below treated that like an expired session: it found the PREVIOUS user's
 * refresh token still in storage, spent it, and wrote their tokens back. The
 * failed sign-in showed its error, the browser quietly held a live session for
 * the last person to use it, and the swap only became visible on the next
 * reload, when `/auth/me` answered as them. Same for a mistyped OTP code.
 */
const AUTH_PATHS = ['/auth/login', '/auth/refresh', '/auth/otp'];
const isAuthRequest = (url?: string) => !!url && AUTH_PATHS.some((p) => url.includes(p));

/** Full navigation, not a router push: it drops the in-memory query cache with
 *  the session, so nothing of the previous user survives into the login screen. */
function bounceToLogin() {
  tokenStore.clear();
  // A full navigation, not a router push: it drops the query cache with the session.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.href = '/login';
}

/**
 * One refresh at a time — in this tab AND across tabs.
 *
 * A reload fires every page query at once, so an expired token used to mean a
 * dozen simultaneous refreshes racing to write the same two keys. They share
 * this promise now and all resume on one new token.
 *
 * Refresh tokens now rotate (each one can be spent once), and every open tab
 * polls, so tabs whose access tokens expire together would otherwise all spend
 * the same refresh token at the same moment. The Web Locks API queues them:
 * the first tab refreshes, the rest wake up to find a renewed token already in
 * the shared storage and simply use it. (The server also honours a
 * just-replaced token for a few seconds, so a browser without Web Locks, or a
 * lost response, still converges rather than signing the user out.)
 */
let refreshing: Promise<string | null> | null = null;

function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) return fn();
  return locks.request('crm.auth.refresh', fn) as Promise<T>;
}

/** `staleAccess` is the token the failed request was sent with. */
async function doRefresh(staleAccess: string | null): Promise<string | null> {
  // Another tab may have refreshed while this one waited for the lock. If the
  // stored token is no longer the one that just failed, it has been renewed —
  // use it instead of spending the refresh token a second time.
  const stored = tokenStore.access;
  if (stored && staleAccess && stored !== staleAccess) return stored;

  const refresh = tokenStore.refresh;
  if (!refresh) {
    bounceToLogin();
    return null;
  }
  // Who the session belonged to BEFORE the refresh, so the answer can be held
  // to it below.
  const before = subjectOf(tokenStore.access) ?? subjectOf(refresh);
  try {
    const { data } = await axios.post(`${API_URL}/api/auth/refresh`, { refreshToken: refresh });
    const after = subjectOf(data.accessToken);
    // A refresh renews a session; it never changes whose it is. If the account
    // came back different, something is wrong with what was in storage — the
    // session is dropped rather than silently continued as someone else.
    if (before && after && before !== after) {
      bounceToLogin();
      return null;
    }
    tokenStore.set(data.accessToken, data.refreshToken);
    return data.accessToken as string;
  } catch (err) {
    // Only the server saying "this session is over" ends it. A network blip, a
    // 5xx or a 429 says nothing about the session — signing the user out for
    // one would throw away a perfectly good session mid-call. Keep the tokens;
    // this request fails and the next one tries the refresh again.
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 400 || status === 401 || status === 403) bounceToLogin();
    return null;
  }
}

function refreshOnce(staleAccess: string | null): Promise<string | null> {
  refreshing ??= withRefreshLock(() => doRefresh(staleAccess)).finally(() => { refreshing = null; });
  return refreshing;
}

/**
 * End this browser's session on the server (logout). The refresh token names
 * the session; the server revokes it, so both tokens stop working everywhere
 * at once. `keepalive` lets the request finish even though the caller
 * navigates away immediately — an ordinary request can be cancelled by that
 * navigation, which would leave the session alive. Best-effort: never throws.
 */
export function revokeSession(): void {
  const refreshToken = tokenStore.refresh;
  if (!refreshToken || typeof fetch === 'undefined') return;
  try {
    void fetch(`${API_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      keepalive: true,
      credentials: 'include',
    }).catch(() => {});
  } catch {
    /* signing out locally must never depend on the network */
  }
}

// Bounded so a hung request (not a fast failure — an actual stalled connection)
// can't leave a caller waiting forever. Matters most for `['me']`: the app
// shell's loading gate can only recover into its error/retry state once this
// request settles one way or the other.
export const api = axios.create({ baseURL: `${API_URL}/api`, withCredentials: true, timeout: 15_000 });

api.interceptors.request.use((config) => {
  const token = tokenStore.access;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// On 401, attempt one refresh then retry; otherwise bounce to login (LGN-008).
api.interceptors.response.use(
  (r) => r,
  async (error) => {
    const original = error.config;
    if (
      error.response?.status !== 401 ||
      !original ||
      original._retry ||
      typeof window === 'undefined' ||
      isAuthRequest(original.url)
    ) {
      return Promise.reject(error);
    }
    original._retry = true;
    const sent = (original.headers?.Authorization as string | undefined)?.replace(/^Bearer\s+/i, '') ?? null;
    const token = await refreshOnce(sent);
    if (!token) return Promise.reject(error);
    original.headers = { ...original.headers, Authorization: `Bearer ${token}` };
    return api(original);
  },
);
