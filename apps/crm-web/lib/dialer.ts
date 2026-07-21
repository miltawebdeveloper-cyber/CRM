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
 * The QUO/OpenPhone app where inbound calls are actually answered. Configurable
 * (e.g. a self-hosted or region-specific host) via NEXT_PUBLIC_OPENPHONE_APP_URL;
 * defaults to the OpenPhone web app.
 */
export const OPENPHONE_APP_URL = process.env.NEXT_PUBLIC_OPENPHONE_APP_URL || 'https://my.openphone.com';

/**
 * Redirect the agent to the calling platform to answer an incoming callback. The
 * CRM only notifies + redirects; the voice call is handled entirely in OpenPhone.
 */
export function openOpenPhoneApp() {
  if (typeof window === 'undefined') return;
  window.open(OPENPHONE_APP_URL, '_blank', 'noopener,noreferrer');
}
