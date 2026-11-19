import { Logger } from '@nestjs/common';

/**
 * Environment checks and the one place auth secrets are read.
 *
 * Every secret used to be read inline as `process.env.X ?? 'change-me-…'`, so a
 * deployment that forgot to set one did not fail — it quietly signed every token
 * with a string that is published in this repository, and anybody could mint an
 * admin token. Secrets are now read through the accessors below, which never
 * fall back to a literal, and `validateEnv` refuses to boot a production
 * process whose secrets are missing, placeholder or shared.
 */

const logger = new Logger('Env');

/** Minimum length accepted for a signing secret in production. */
const MIN_SECRET_LENGTH = 32;

const isProduction = () => process.env.NODE_ENV === 'production';

/** True for the literal placeholders that ship in `.env.example` and old code. */
function isPlaceholder(v: string): boolean {
  return /^change[-_]?me/i.test(v) || /^(secret|password|test|dev)$/i.test(v);
}

/** Problems with one signing secret, as phrases for the boot error. */
function secretProblems(name: string, value: string | undefined): string[] {
  if (!value || !value.trim()) return [`${name} is not set`];
  const problems: string[] = [];
  if (isPlaceholder(value)) problems.push(`${name} is still a placeholder value`);
  if (value.length < MIN_SECRET_LENGTH) problems.push(`${name} is shorter than ${MIN_SECRET_LENGTH} characters`);
  return problems;
}

/**
 * `ConfigModule.forRoot({ validate })` hook — runs once at boot, before any
 * provider is constructed, with the merged `.env` + process environment.
 *
 * Production: any problem is fatal. A secret that is missing, a placeholder,
 * too short, or the same for access and refresh tokens (which would let a
 * refresh token pass as an access token) stops the process with a message that
 * names the variable — a crash at deploy time is the cheap version of this bug.
 *
 * Everywhere else: missing secrets are still fatal (there is no safe default to
 * fall back to), but weak ones only warn, so a local `.env` copied from the
 * example keeps working.
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  // Jest builds modules without a real environment; nothing here applies.
  if (process.env.NODE_ENV === 'test') return config;

  const get = (k: string) => {
    const v = config[k] ?? process.env[k];
    return typeof v === 'string' ? v : v == null ? undefined : String(v);
  };

  const fatal: string[] = [];
  const weak: string[] = [];

  if (!get('DATABASE_URL')?.trim()) fatal.push('DATABASE_URL is not set');

  const access = get('JWT_ACCESS_SECRET');
  const refresh = get('JWT_REFRESH_SECRET');
  for (const [name, value] of [['JWT_ACCESS_SECRET', access], ['JWT_REFRESH_SECRET', refresh]] as const) {
    const problems = secretProblems(name, value);
    // A secret that is simply absent has no fallback in any environment.
    if (!value?.trim()) fatal.push(...problems);
    else (isProduction() ? fatal : weak).push(...problems);
  }
  if (access && refresh && access === refresh) {
    (isProduction() ? fatal : weak).push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different');
  }

  // Optional: falls back to the access secret when blank. Checked only when set.
  const device = get('TRUSTED_DEVICE_SECRET');
  if (device?.trim()) {
    const problems = secretProblems('TRUSTED_DEVICE_SECRET', device);
    (isProduction() ? fatal : weak).push(...problems);
  }

  // Optional: encrypts TOTP secrets at rest. Checked only when set; its absence
  // is a warning (MFA still works, secrets are stored unencrypted).
  const mfaKey = get('MFA_ENCRYPTION_KEY');
  if (mfaKey?.trim()) {
    (isProduction() ? fatal : weak).push(...secretProblems('MFA_ENCRYPTION_KEY', mfaKey));
  } else if (isProduction()) {
    logger.warn('MFA_ENCRYPTION_KEY is not set — TOTP secrets will be stored unencrypted.');
  }

  if (isProduction() && !get('WEB_ORIGIN')?.trim()) {
    // Not fatal — CORS falls back to localhost, which fails safe (the browser
    // app simply can't call the API) — but it is never what production wants.
    logger.warn('WEB_ORIGIN is not set — CORS will only allow http://localhost:3000.');
  }

  for (const w of weak) logger.warn(`${w} — acceptable for local development only; production refuses to start with this.`);
  if (fatal.length) {
    throw new Error(
      `Refusing to start — environment is not safe:\n  • ${fatal.join('\n  • ')}\n` +
        'Set strong, distinct values (e.g. `openssl rand -base64 48`) in the service environment.',
    );
  }
  return config;
}

/** Read a required secret. Throws rather than ever returning a default. */
function requireSecret(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} is not set`);
  return v;
}

/** Signing secret for access tokens. */
export const jwtAccessSecret = (): string => requireSecret('JWT_ACCESS_SECRET');

/** Signing secret for refresh tokens. */
export const jwtRefreshSecret = (): string => requireSecret('JWT_REFRESH_SECRET');

/**
 * Signing secret for the trusted-device cookie. `||`, not `??`: the example env
 * ships `TRUSTED_DEVICE_SECRET=""`, and an empty string is not nullish — with
 * `??` it became the HMAC key itself.
 */
export const trustedDeviceSecret = (): string =>
  process.env.TRUSTED_DEVICE_SECRET?.trim() || jwtAccessSecret();
