import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verifySync } from 'otplib';
import * as QRCode from 'qrcode';

/** Prefix of an encrypted stored secret: `enc:v1:<iv>:<tag>:<ciphertext>` (base64url parts). */
const SEALED_PREFIX = 'enc:v1:';

/**
 * TOTP MFA helper (brief: Multi-Factor Authentication). otplib v13 functional API.
 *
 * Secrets at rest: the TOTP secret IS the second factor — anyone holding it can
 * generate valid codes forever — so it is stored encrypted (AES-256-GCM) when
 * MFA_ENCRYPTION_KEY is set, rather than in plain text where a database dump or
 * backup would hand over every account's second factor. Rows written before
 * encryption existed are still read as plain text and are sealed on their next
 * successful use (see AuthService), so turning the key on needs no migration.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);
  private warnedNoKey = false;

  generateSecret(): string {
    return generateSecret();
  }

  /** otpauth:// URI rendered as a data-URL QR for authenticator apps. */
  async buildQrCode(email: string, secret: string): Promise<string> {
    const issuer = process.env.MFA_ISSUER ?? 'CRM Lead & Sales';
    const otpauth = generateURI({ issuer, label: email, secret });
    return QRCode.toDataURL(otpauth);
  }

  /** Check a code against a STORED secret (sealed or legacy plain text). */
  verify(token: string, storedSecret: string): boolean {
    return verifySync({ token, secret: this.open(storedSecret) }).valid;
  }

  /** Whether a stored secret predates encryption and should be re-sealed. */
  needsSealing(storedSecret: string): boolean {
    return !!this.key() && !storedSecret.startsWith(SEALED_PREFIX);
  }

  /** Prepare a secret for storage: encrypted when a key is configured. */
  seal(secret: string): string {
    const key = this.key();
    if (!key) {
      if (process.env.NODE_ENV === 'production' && !this.warnedNoKey) {
        this.warnedNoKey = true;
        this.logger.warn('MFA_ENCRYPTION_KEY is not set — TOTP secrets are being stored unencrypted.');
      }
      return secret;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${SEALED_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
  }

  /** Recover the secret from storage. Throws if a sealed secret can't be opened. */
  open(stored: string): string {
    if (!stored.startsWith(SEALED_PREFIX)) return stored; // legacy plain text
    const key = this.key();
    if (!key) throw new Error('MFA secret is encrypted but MFA_ENCRYPTION_KEY is not set');
    const [iv, tag, ciphertext] = stored.slice(SEALED_PREFIX.length).split(':');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  }

  /**
   * 32-byte AES key derived from MFA_ENCRYPTION_KEY (any length; hashed so a
   * passphrase works as well as a raw key). Null when unset. Changing it makes
   * every sealed secret unreadable, so those users must re-enrol.
   */
  private key(): Buffer | null {
    const raw = process.env.MFA_ENCRYPTION_KEY?.trim();
    return raw ? createHash('sha256').update(raw).digest() : null;
  }
}
