import { afterEach, describe, expect, it } from '@jest/globals';
import { generateSync } from 'otplib';
import { MfaService } from './mfa.service.js';

/**
 * TOTP secrets are the second factor itself. These pin that they are stored
 * encrypted when a key is configured, that legacy plain-text rows keep working,
 * and that a sealed secret can't be read with the wrong key.
 */
describe('MfaService secrets at rest', () => {
  const saved = process.env.MFA_ENCRYPTION_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.MFA_ENCRYPTION_KEY;
    else process.env.MFA_ENCRYPTION_KEY = saved;
  });

  it('seals a secret so the stored value is not the secret, and verifies codes through it', () => {
    process.env.MFA_ENCRYPTION_KEY = 'a-long-test-encryption-key-for-mfa-secrets';
    const mfa = new MfaService();
    const secret = mfa.generateSecret();
    const stored = mfa.seal(secret);
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain(secret);
    expect(mfa.open(stored)).toBe(secret);
    expect(mfa.verify(generateSync({ secret }), stored)).toBe(true);
  });

  it('still reads legacy plain-text secrets, and flags them for sealing', () => {
    process.env.MFA_ENCRYPTION_KEY = 'a-long-test-encryption-key-for-mfa-secrets';
    const mfa = new MfaService();
    const secret = mfa.generateSecret();
    expect(mfa.verify(generateSync({ secret }), secret)).toBe(true);
    expect(mfa.needsSealing(secret)).toBe(true);
    expect(mfa.needsSealing(mfa.seal(secret))).toBe(false);
  });

  it('refuses to open a sealed secret with a different key', () => {
    process.env.MFA_ENCRYPTION_KEY = 'the-original-key-the-original-key-xx';
    const mfa = new MfaService();
    const stored = mfa.seal(mfa.generateSecret());
    process.env.MFA_ENCRYPTION_KEY = 'some-other-key-some-other-key-some-xx';
    expect(() => mfa.open(stored)).toThrow();
  });

  it('stores plain text when no key is configured (MFA keeps working)', () => {
    delete process.env.MFA_ENCRYPTION_KEY;
    const mfa = new MfaService();
    const secret = mfa.generateSecret();
    expect(mfa.seal(secret)).toBe(secret);
    expect(mfa.needsSealing(secret)).toBe(false);
  });
});
