import { ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard, type ThrottlerOptions } from '@nestjs/throttler';
import { jwtAccessSecret } from '../env.js';

/**
 * Rate limiting that counts the right thing.
 *
 * The stock guard keys every counter on `req.ip`. Behind the hosting proxy
 * (without `trust proxy`) that was the PROXY's address, and even with it, a
 * call centre's agents share one office IP — so the whole floor drew from one
 * bucket per route. The incoming-call popup polls once a second per tab, so two
 * agents together crossed the 100/min limit, the poll started answering 429,
 * and ringing calls silently stopped popping. Sign-in had the same flaw: the
 * 21st login from the office in 15 minutes was refused.
 *
 * Now:
 *  • a signed-in request is counted per USER, taken from a verified access
 *    token (never from an unverified claim, which anyone could vary to dodge
 *    the limit);
 *  • a sign-in attempt (`@AuthAttempt()`) is counted per IP AND account, so one
 *    person's typos never lock out a colleague; the separate `authIp` throttler
 *    adds a generous per-IP ceiling against password spraying;
 *  • anything else falls back to the client IP (correct once `trust proxy` is
 *    set — see main.ts).
 */

export const AUTH_ATTEMPT_KEY = 'crm:authAttempt';

/**
 * Marks a sign-in step (login, OTP verify/resend). Its `default` limit counts
 * per IP + account, and the `authIp` throttler's per-IP ceiling applies to it.
 */
export const AuthAttempt = () => SetMetadata(AUTH_ATTEMPT_KEY, true);

/** True when the route being throttled is marked `@AuthAttempt()`. */
export function isAuthAttempt(context: ExecutionContext): boolean {
  return Reflect.getMetadata(AUTH_ATTEMPT_KEY, context.getHandler()) === true;
}

/** The caller's address. Real only when `trust proxy` matches the deployment's proxy hops. */
export function clientIp(req: Record<string, any>): string {
  return String(req.ip ?? req.socket?.remoteAddress ?? 'unknown');
}

/**
 * The throttlers the API runs (AppModule), in one place so tests exercise the
 * real configuration.
 *  • default: 100/min per route, counted per user / per IP+account / per IP
 *    (see the guard). Routes override it — the 1 s polls allow more, sign-in less.
 *  • authIp: a per-IP ceiling on sign-in attempts across all accounts (password
 *    spraying), sized so a whole office can sign in at shift start. Applies only
 *    to routes marked @AuthAttempt(). AUTH_IP_LIMIT overrides the 300.
 */
export function crmThrottlers(): ThrottlerOptions[] {
  return [
    { name: 'default', ttl: 60_000, limit: 100 },
    {
      name: 'authIp',
      ttl: 15 * 60_000,
      limit: Number(process.env.AUTH_IP_LIMIT) || 300,
      getTracker: (req) => `ip:${clientIp(req)}`,
      skipIf: (context) => !isAuthAttempt(context),
    },
  ];
}

@Injectable()
export class CrmThrottlerGuard extends ThrottlerGuard {
  private readonly jwt = new JwtService();

  protected async getTracker(req: Record<string, any>, context?: ExecutionContext): Promise<string> {
    const ip = clientIp(req);
    if (context && isAuthAttempt(context)) {
      // `email` on login, `challengeId` on the OTP steps.
      const account = String(req.body?.email ?? req.body?.challengeId ?? '').trim().toLowerCase().slice(0, 200);
      return account ? `acct:${ip}:${account}` : `ip:${ip}`;
    }
    const user = this.userFromToken(req);
    return user ? `user:${user}` : `ip:${ip}`;
  }

  /** The verified subject of a bearer access token, or null. Never trusts an unverified claim. */
  private userFromToken(req: Record<string, any>): string | null {
    const header = req.headers?.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    try {
      const claims = this.jwt.verify<{ sub?: string; typ?: string }>(header.slice(7), { secret: jwtAccessSecret() });
      return claims.typ === 'access' && claims.sub ? claims.sub : null;
    } catch {
      // Expired or forged: counted by IP, and the auth guard will refuse it anyway.
      return null;
    }
  }
}
