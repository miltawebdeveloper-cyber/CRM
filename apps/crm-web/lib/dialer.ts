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
