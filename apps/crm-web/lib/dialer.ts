/**
 * Open the QUO/OpenPhone dial pad for a phone number, prefilled.
 *
 * Must be called INSIDE a user click (button onClick). Browsers block opening an
 * external protocol handler (`tel:` → QUO) from an async callback or effect, so
 * every Call button opens the dialer synchronously here, then navigates to the
 * Calling Panel to log + monitor the call.
 *
 * On desktop this opens QUO only when it's set as the default calling app; on
 * mobile the QUO app handles the tel: link.
 */
export function openQuoDialer(phone?: string | null) {
  if (typeof window === 'undefined' || !phone) return;
  const a = document.createElement('a');
  a.href = `tel:${phone}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Custom URL scheme that launches the installed Quo/OpenPhone DESKTOP app. The OS
 * hands a `scheme://` link to the app's registered protocol handler — the same
 * mechanism as `slack://` or `zoommtg://` — so this opens the native desktop app,
 * not a browser tab. Configurable because the scheme is brand-specific
 * (OpenPhone: `openphone://`, Quo: `quo://`); set NEXT_PUBLIC_QUO_APP_SCHEME.
 */
export const QUO_APP_SCHEME = process.env.NEXT_PUBLIC_QUO_APP_SCHEME || 'openphone://';

/**
 * Open the Quo/OpenPhone DESKTOP app so the agent can answer an incoming call.
 * Must run inside a user click (the Attend button) — browsers only hand a custom
 * protocol to the desktop app from a real gesture. If the desktop app isn't
 * installed the OS simply ignores the link; the CRM tab is left untouched.
 */
export function openOpenPhoneApp() {
  if (typeof window === 'undefined') return;
  const a = document.createElement('a');
  a.href = QUO_APP_SCHEME; // e.g. openphone:// → launches the installed desktop app
  document.body.appendChild(a);
  a.click();
  a.remove();
}
