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
  window.location.href = '/login';
}

/**
 * One refresh at a time.
 *
 * A reload fires every page query at once, so an expired token used to mean a
 * dozen simultaneous refreshes racing to write the same two keys. They share
 * this promise now and all resume on one new token.
 */
let refreshing: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
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
  } catch {
    bounceToLogin();
    return null;
  }
}

function refreshOnce(): Promise<string | null> {
  refreshing ??= doRefresh().finally(() => { refreshing = null; });
  return refreshing;
}

export const api = axios.create({ baseURL: `${API_URL}/api`, withCredentials: true });

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
    const token = await refreshOnce();
    if (!token) return Promise.reject(error);
    original.headers = { ...original.headers, Authorization: `Bearer ${token}` };
    return api(original);
  },
);
