/**
 * Escape text for an HTML email body.
 *
 * Notification and OTP emails are built from data the CRM does not control:
 * lead names and notes arrive from spreadsheet imports and inbound webhooks, and
 * user names are typed in by admins. Interpolated raw, a lead called
 * `<a href="https://evil.example">Click to verify your account</a>` became a real
 * link in an email to every manager — an ideal phishing lure, because it comes
 * from the CRM itself.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Plain text → a minimal HTML paragraph, escaped, line breaks kept. */
export const textToHtml = (text: string): string => `<p>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</p>`;
