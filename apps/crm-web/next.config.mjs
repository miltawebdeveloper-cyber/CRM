/** @type {import('next').NextConfig} */

/**
 * Security response headers, applied to every route (Vercel honours these).
 *
 * Scope note: these are the headers that harden the app with no risk of breaking
 * it. A full resource Content-Security-Policy (locking down script/style/connect
 * sources) is intentionally NOT set here — it must be built from the API/WS
 * origins and tested against the running app first, or it silently breaks pages.
 * What IS set below via CSP are only the three directives that can't break
 * anything: frame-ancestors (clickjacking), base-uri, and form-action.
 */
const securityHeaders = [
  // Force HTTPS for two years, including subdomains. Safe: the app is HTTPS-only.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  // Belt-and-braces clickjacking protection (older browsers) alongside CSP frame-ancestors.
  { key: 'X-Frame-Options', value: 'DENY' },
  // Stop browsers from MIME-sniffing a response into a different content type.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Don't leak full URLs (which can carry ids) to other origins.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Disable powerful features the CRM doesn't use in the browser. Microphone is
  // left untouched on purpose so future in-browser calling isn't blocked.
  { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), browsing-topics=()' },
  // Only the non-breaking CSP directives: no site may frame us, and <base>/form
  // targets are pinned to our own origin. Resource directives are omitted by design.
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
];

const nextConfig = {
  reactStrictMode: true,
  // Hide the Next.js dev tools indicator (the floating Route/Bundler/Preferences menu).
  devIndicators: false,
  // Don't scaffold AGENTS.md/CLAUDE.md into the app on every dev start.
  agentRules: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
