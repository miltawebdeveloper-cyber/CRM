/**
 * Every call the CRM places goes through the Quo app — never the browser.
 *
 * Quo (OpenPhone) publishes a URL scheme for this:
 *
 *     openphone://dial?number=<e164>&from=<line>&action=call
 *
 * The OS hands that link to the installed Quo app's registered protocol handler,
 * the same mechanism as `slack://` or `zoommtg://`. Nothing navigates, no tab is
 * opened, and the CRM page the agent was on stays exactly where it was.
 *
 * This deliberately replaces the old `tel:` handoff. `tel:` goes to whatever the
 * OS has registered as the default calling app — frequently a browser page,
 * Windows Phone Link, or a "How do you want to open this?" chooser — which is the
 * browser redirection this must never do. `tel:` remains available only as an
 * opt-in fallback for deployments without the Quo app installed
 * (NEXT_PUBLIC_QUO_TEL_FALLBACK=true).
 *
 * Vendor caveat, worth knowing: Quo documents deep links as supported on its
 * MOBILE apps. On desktop the scheme still launches the installed Quo app (that
 * is how the incoming-call "Attend" button has always worked); whether the
 * desktop build also auto-dials the number depends on it honouring the
 * parameters. Either way the call lands in Quo, never in a browser.
 */

/** Scheme the installed Quo/OpenPhone app registers (OpenPhone: `openphone://`, Quo: `quo://`). */
export const QUO_APP_SCHEME = process.env.NEXT_PUBLIC_QUO_APP_SCHEME || 'openphone://';

/**
 * Override for the whole dial URL, with `{number}` and `{from}` placeholders
 * (both URL-encoded when substituted), e.g.
 * `openphone://dial?number={number}&from={from}&action=call`.
 *
 * Exists because the vendor guarantees this scheme on its mobile apps only: if a
 * desktop build turns out to want a different path or parameter names, that is an
 * env change on a running deployment rather than a code change and redeploy.
 */
const DIAL_TEMPLATE = process.env.NEXT_PUBLIC_QUO_DIAL_TEMPLATE || '';

/** Opt-in `tel:` fallback for machines without the Quo app. Off by default — see above. */
const TEL_FALLBACK = process.env.NEXT_PUBLIC_QUO_TEL_FALLBACK === 'true';

/** `openphone://` → `openphone`, so a path can be appended predictably. */
function schemeRoot(): string {
  return QUO_APP_SCHEME.replace(/:\/\/.*$/, '').replace(/:$/, '');
}

/**
 * E.164-ish normalisation. Quo wants the number URL-encoded, and a `+` must
 * survive as `%2B`; `encodeURIComponent` handles that once the string is clean.
 * Leaves user direct numbers (which contain `@`) alone apart from encoding.
 */
export function toDialNumber(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.includes('@')) return trimmed; // Quo direct number, e.g. 123@user
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return `+${digits.slice(1).replace(/\D/g, '')}`;
  const bare = digits.replace(/\D/g, '');
  // 10 digits = US/CA national format in this CRM's data; anything else is passed
  // through as dialled rather than guessed at.
  return bare.length === 10 ? `+1${bare}` : bare;
}

/**
 * The deep link that places the call. `from` pins the outgoing line to the
 * agent's own Quo number, so the customer sees the right caller ID even when the
 * agent's Quo app has several lines.
 */
export function buildQuoDialUrl(phone: string, from?: string | null): string {
  const number = toDialNumber(phone);
  const line = from?.trim() ? toDialNumber(from) : '';
  if (DIAL_TEMPLATE) {
    return DIAL_TEMPLATE.replace('{number}', encodeURIComponent(number)).replace('{from}', encodeURIComponent(line));
  }
  const params = new URLSearchParams();
  params.set('number', number);
  if (line) params.set('from', line);
  params.set('action', 'call'); // dial immediately rather than just prefilling
  return `${schemeRoot()}://dial?${params.toString()}`;
}

/**
 * Hand a URL to the OS without navigating this page.
 *
 * An anchor click is used rather than `window.open` (which opens a browser tab)
 * or `location.href` (which would navigate the CRM away and, if no handler is
 * registered, strand the agent on an error page). If nothing handles the scheme
 * the OS simply ignores it and the CRM is untouched.
 *
 * Must run INSIDE a real user gesture — browsers refuse to hand an external
 * protocol to an app from a timer or an async callback. Every Call button
 * therefore launches synchronously and logs the call afterwards.
 */
function handoff(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Place a call through the Quo app. The single entry point for every call action
 * in the CRM — click-to-call, queue calls, callbacks, redial and the dial pad —
 * so there is exactly one place where a call can reach the OS.
 */
export function launchQuoCall(phone?: string | null, from?: string | null) {
  if (typeof window === 'undefined' || !phone?.trim()) return;
  handoff(buildQuoDialUrl(phone, from));
  if (TEL_FALLBACK) handoff(`tel:${toDialNumber(phone)}`);
}

/**
 * Open the Quo app itself, with no number — used by the incoming-call popup's
 * Attend button, where the call is already ringing inside Quo and only needs
 * bringing to the front.
 */
export function openQuoApp() {
  if (typeof window === 'undefined') return;
  handoff(QUO_APP_SCHEME);
}
