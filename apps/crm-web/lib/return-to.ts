/**
 * Where to go back to after signing in.
 *
 * A page opened while signed out — a lead link from an e-mail after the
 * session lapsed, a bookmark — used to send its reader to the login screen and
 * then to the dashboard, wherever they had been heading. The login URL now
 * carries the page (`/login?next=/leads/…`), and signing in goes there.
 *
 * Only a path on THIS site is ever followed. `next` comes from the address bar,
 * which anyone can write, so an absolute URL, a protocol-relative `//host`, a
 * backslash form some browsers read as one, or anything with control
 * characters (which browsers strip, turning `/\t/host` into `//host`) is
 * refused — otherwise the login page becomes a way to bounce a freshly signed-in
 * user to somebody else's site.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\s\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, 'https://crm.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'https://crm.invalid') return null;
  // Back to the login screen itself would just loop.
  if (url.pathname === '/login' || url.pathname.startsWith('/login/')) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The login URL for someone who was on `from` — with it attached when it's worth returning to. */
export function loginUrl(from?: string | null): string {
  const back = safeReturnPath(from);
  return back && back !== '/' ? `/login?next=${encodeURIComponent(back)}` : '/login';
}
