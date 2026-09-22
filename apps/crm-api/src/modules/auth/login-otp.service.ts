import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MailService } from '../mail/mail.service.js';

/** AppSetting row holding the OTP configuration (no migration needed — JSON blob). */
const OTP_SETTINGS_KEY = 'auth:otp';

export interface OtpSettings {
  /** Master switch. OFF by default — see `DEFAULTS`. */
  enabled: boolean;
  expiryMinutes: number;
  maxAttempts: number;
  resendSeconds: number;
  /**
   * Remember the browser after a successful code, so the next logins from it skip
   * the OTP step. Turn OFF to demand a code on every single login.
   */
  trustDeviceEnabled: boolean;
  /** How long a device stays trusted before a fresh code is required again. */
  trustDeviceDays: number;
}

/**
 * Deliberately DISABLED by default.
 *
 * The code is delivered by email, and this deployment has no SMTP configured —
 * MailService logs instead of sending. Shipping this on would mean nobody could
 * ever receive a code, i.e. nobody could log in. An admin turns it on once mail
 * actually works.
 */
const DEFAULTS: OtpSettings = {
  enabled: false,
  expiryMinutes: 5,
  maxAttempts: 5,
  resendSeconds: 60,
  trustDeviceEnabled: true,
  trustDeviceDays: 180,
};

@Injectable()
export class LoginOtpService {
  private readonly logger = new Logger(LoginOtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  // ── Settings ──

  /**
   * Short-lived in-memory copy of the settings row.
   *
   * These are read several times per sign-in — the login gate, then again inside
   * `issue`, then again on verify — and they are a row an admin edits perhaps
   * twice a year. Every one of those reads was a database round trip on the
   * critical path of a login. Cached for a few seconds, and dropped the instant
   * this instance saves a change, so the admin panel still reflects itself
   * immediately; another instance picks the change up within the TTL.
   */
  private cache: { at: number; value: OtpSettings } | null = null;
  private static readonly CACHE_TTL_MS = 15_000;

  async getSettings(): Promise<OtpSettings> {
    const cached = this.cache;
    if (cached && Date.now() - cached.at < LoginOtpService.CACHE_TTL_MS) return cached.value;

    const row = await this.prisma.appSetting.findUnique({ where: { key: OTP_SETTINGS_KEY } });
    const stored = (row?.value as Partial<OtpSettings> | undefined) ?? {};
    // Named fields only — a blind spread would keep resurrecting retired keys
    // (like the old global `recipientEmail`) out of whatever JSON happens to
    // already be sitting in the row forever, since every save reads this back
    // and writes it straight out again.
    const merged: OtpSettings = {
      enabled: stored.enabled ?? DEFAULTS.enabled,
      expiryMinutes: stored.expiryMinutes ?? DEFAULTS.expiryMinutes,
      maxAttempts: stored.maxAttempts ?? DEFAULTS.maxAttempts,
      resendSeconds: stored.resendSeconds ?? DEFAULTS.resendSeconds,
      trustDeviceEnabled: stored.trustDeviceEnabled ?? DEFAULTS.trustDeviceEnabled,
      trustDeviceDays: stored.trustDeviceDays ?? DEFAULTS.trustDeviceDays,
    };
    this.cache = { at: Date.now(), value: merged };
    return merged;
  }

  async saveSettings(patch: Partial<OtpSettings>): Promise<OtpSettings> {
    const next: OtpSettings = { ...(await this.getSettings()), ...patch };
    next.expiryMinutes = Math.min(60, Math.max(1, Math.round(next.expiryMinutes)));
    next.maxAttempts = Math.min(10, Math.max(1, Math.round(next.maxAttempts)));
    next.resendSeconds = Math.min(600, Math.max(15, Math.round(next.resendSeconds)));
    next.trustDeviceDays = Math.min(365, Math.max(1, Math.round(next.trustDeviceDays)));
    await this.prisma.appSetting.upsert({
      where: { key: OTP_SETTINGS_KEY },
      create: { key: OTP_SETTINGS_KEY, value: { ...next } },
      update: { value: { ...next } },
    });
    this.cache = null; // an admin who just saved must not read the old copy back
    return next;
  }

  /** Whether real SMTP delivery is available — surfaced so the UI can warn. */
  get mailReady(): boolean {
    return this.mail.enabled;
  }

  // ── Challenges ──

  /**
   * Issue a code for a user who has already passed the password check, and mail it
   * to THAT user's own registered email — never a shared or configured address, so
   * one account's code can never land in another account's inbox. Returns the
   * challenge id the client echoes back.
   */
  async issue(user: { id: string; email: string; name: string }): Promise<{ challengeId: string; sentTo: string; resendSeconds: number }> {
    const s = await this.getSettings();
    const to = user.email;

    // 6 digits from a CSPRNG — Math.random is not acceptable for a login secret.
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + s.expiryMinutes * 60_000);

    // Hashing the code and retiring any earlier pending challenge for this user
    // have nothing to do with each other — one is CPU, one is the database — so
    // they overlap instead of queueing. Retiring matters either way: only the
    // newest code can ever be used.
    const [codeHash] = await Promise.all([
      bcrypt.hash(code, 10),
      this.prisma.loginOtp.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
    ]);

    const row = await this.prisma.loginOtp.create({
      data: { userId: user.id, codeHash, expiresAt, sentTo: to },
      select: { id: true },
    });

    // Both of these now happen after the caller has its answer. The challenge is
    // durable at this point, so the OTP screen is safe to show; making the user
    // watch an SMTP handshake before it appears was the single slowest thing in
    // signing in, and the audit write behind it added another round trip for a
    // record nobody is waiting to read.
    this.deliver(to, user, code, s.expiryMinutes);
    void this.audit(user.id, 'otp_generated', `Login OTP issued to ${to} (expires in ${s.expiryMinutes}m)`);
    return { challengeId: row.id, sentTo: to, resendSeconds: s.resendSeconds };
  }

  /**
   * Check a submitted code. Consumes the challenge on success so a code can never
   * be replayed, and counts failures against the configured cap.
   */
  async verify(challengeId: string, code: string): Promise<{ userId: string }> {
    const otp = await this.prisma.loginOtp.findUnique({ where: { id: challengeId } });
    // Same generic message for unknown / used / expired: never reveal which.
    if (!otp || otp.consumedAt) throw new UnauthorizedException('This code is no longer valid. Request a new one.');
    if (otp.expiresAt < new Date()) throw new UnauthorizedException('This code has expired. Request a new one.');

    const s = await this.getSettings();
    if (otp.attempts >= s.maxAttempts) {
      await this.prisma.loginOtp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
      void this.audit(otp.userId, 'otp_locked', 'Login OTP locked after too many incorrect attempts');
      throw new UnauthorizedException('Too many incorrect attempts. Request a new code.');
    }

    if (!(await bcrypt.compare(code, otp.codeHash))) {
      const attempts = otp.attempts + 1;
      await this.prisma.loginOtp.update({ where: { id: otp.id }, data: { attempts } });
      void this.audit(otp.userId, 'otp_failed', `Incorrect login OTP (attempt ${attempts} of ${s.maxAttempts})`);
      throw new UnauthorizedException(`Incorrect code. ${Math.max(0, s.maxAttempts - attempts)} attempt(s) remaining.`);
    }

    // Burn it immediately — one code, one login. This one stays awaited: the
    // whole guarantee is that the row is spent before tokens are issued.
    await this.prisma.loginOtp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
    void this.audit(otp.userId, 'otp_verified', 'Login OTP verified');
    return { userId: otp.userId };
  }

  /** Re-send the code for a pending challenge, honouring the resend interval. */
  async resend(challengeId: string): Promise<{ challengeId: string; sentTo: string; resendSeconds: number }> {
    const otp = await this.prisma.loginOtp.findUnique({
      where: { id: challengeId },
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    if (!otp || otp.consumedAt) throw new UnauthorizedException('This code is no longer valid. Sign in again.');

    const s = await this.getSettings();
    const waited = (Date.now() - otp.createdAt.getTime()) / 1000;
    if (waited < s.resendSeconds) {
      throw new BadRequestException(`Please wait ${Math.ceil(s.resendSeconds - waited)}s before requesting another code.`);
    }
    // Issuing retires this challenge and starts a fresh one.
    return this.issue(otp.user);
  }

  // ── Internals ──

  /** Queues the mail and returns; delivery finishes after the response. */
  private deliver(to: string, user: { email: string; name: string }, code: string, minutes: number): void {
    this.mail.sendInBackground({
      to,
      subject: 'CRM Login Verification Code',
      text: `Your One-Time Password (OTP) for CRM login is: ${code}\n\nThis OTP is valid for ${minutes} minutes.\nDo not share this code with anyone.\n\nRequested for: ${user.name} <${user.email}>`,
      html: `
        <p>Your One-Time Password (OTP) for CRM login is:</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:12px 0">${code}</p>
        <p>This OTP is valid for <strong>${minutes} minutes</strong>.</p>
        <p>Do not share this code with anyone.</p>
        <hr />
        <p style="color:#666;font-size:12px">Requested for ${user.name} &lt;${user.email}&gt;</p>
      `,
    });
    // Without SMTP the mail service silently no-ops, which would strand every
    // login. Put the code where an admin can still find it, and say why.
    if (!this.mail.enabled) {
      this.logger.warn(`SMTP is not configured — login OTP for ${to} was NOT emailed. Code: ${code}`);
    }
  }

  /** Audit trail. leadId is null: this is an account event, not a lead event. */
  private async audit(userId: string, action: string, remarks: string) {
    try {
      await this.prisma.activity.create({ data: { leadId: null, userId, action, oldValue: null, newValue: null, remarks } });
    } catch {
      /* auditing must never block a login */
    }
  }
}
