'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { api, tokenStore } from '@/lib/api';

/** Pull the API's message out of an axios error. */
function msgOf(err: unknown, fallback: string): string {
  const m = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (Array.isArray(m)) return String(m[0]);
  return typeof m === 'string' && m ? m : fallback;
}

export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [mfaToken, setMfaToken] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  /**
   * How many people use this workspace, for the stat row on the brand panel.
   *
   * Fetched rather than hardcoded so it cannot go stale the way "4 Timezones"
   * did. Failure is silent and the tile disappears: this is decoration on the
   * one screen that must always work, and nobody should be kept from signing in
   * because a count didn't load.
   */
  const [userCount, setUserCount] = useState<number | null>(null);

  /**
   * The dashboard is the only place this page ever goes, so its route bundle is
   * pulled down while the password is still being typed. Without this the
   * redirect after a correct password is a cold chunk download — the tokens are
   * already in hand and the screen still sits on "Signing in…".
   */
  useEffect(() => {
    router.prefetch('/dashboard');
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/auth/workspace-stats')
      .then((r) => {
        if (!cancelled && typeof r.data?.users === 'number' && r.data.users > 0) setUserCount(r.data.users);
      })
      .catch(() => {
        /* offline, or the API is down — the sign-in form is what matters here */
      });
    return () => { cancelled = true; };
  }, []);

  // ── Email-OTP step ──
  // The password check hands back a challenge instead of tokens; nothing is
  // granted until the code that was mailed out is exchanged here.
  const [challenge, setChallenge] = useState<{ id: string; sentTo: string; trustDays: number } | null>(null);
  const [code, setCode] = useState('');
  const [cooldown, setCooldown] = useState(0);

  // Resend countdown.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  function finish(data: { accessToken: string; refreshToken: string }) {
    tokenStore.set(data.accessToken, data.refreshToken);
    // Nothing cached under the previous session follows this one into the app.
    //
    // Today every route that reaches this page is a full navigation — logout in
    // the topbar, the 401 bounce in the API client — and both drop the cache on
    // the way, so this is belt and braces. But that is a promise held by two
    // call sites remembering to use `window.location`, and the failure it
    // guards against is the worst kind: `router.push` from anywhere into
    // `/login` would leave the last user's `me`, their role and their rows in
    // memory for the next person to sign in and see. Clearing it here makes the
    // guarantee belong to the login itself.
    queryClient.clear();
    router.push('/dashboard');
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', { email, password, ...(mfaToken ? { mfaToken } : {}) });
      if (data.mfaRequired) {
        setMfaRequired(true);
        return;
      }
      if (data.otpRequired) {
        setChallenge({ id: data.challengeId, sentTo: data.sentTo, trustDays: data.trustDeviceDays ?? 0 });
        setCooldown(data.resendSeconds ?? 60);
        setCode('');
        return;
      }
      finish(data);
    } catch (err: unknown) {
      setError(msgOf(err, 'Login failed'));
    } finally {
      setLoading(false);
    }
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/otp/verify', { challengeId: challenge.id, code });
      finish(data);
    } catch (err: unknown) {
      setError(msgOf(err, 'Verification failed'));
    } finally {
      setLoading(false);
    }
  }

  async function onResend() {
    if (!challenge || cooldown > 0) return;
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/otp/resend', { challengeId: challenge.id });
      setChallenge({ ...challenge, id: data.challengeId, sentTo: data.sentTo });
      setCooldown(data.resendSeconds ?? 60);
      setCode('');
    } catch (err: unknown) {
      setError(msgOf(err, 'Could not resend the code'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-screen md:grid-cols-[1.05fr_.95fr]" style={{ background: 'var(--brand-ink-2)' }}>
      {/* Brand side */}
      <div
        className="relative hidden flex-col justify-between overflow-hidden p-[54px_60px] text-[#f3f5ef] md:flex"
        style={{
          background:
            'radial-gradient(120% 90% at 0% 0%,rgba(111,135,69,.55),transparent 55%),radial-gradient(130% 100% at 100% 100%,rgba(28,35,22,.9),transparent 60%),linear-gradient(160deg,#183e1a,var(--brand-ink-2) 70%)',
        }}
      >
        <svg className="pointer-events-none absolute inset-0 opacity-[.16]" viewBox="0 0 600 800" preserveAspectRatio="xMidYMid slice">
          <g fill="none" stroke="#a6c15c" strokeWidth="1">
            <path d="M-50 120 Q150 60 350 140 T780 120" /><path d="M-50 180 Q150 120 350 200 T780 180" />
            <path d="M-50 250 Q180 180 360 270 T800 250" /><path d="M-50 330 Q160 270 380 350 T820 330" />
            <path d="M-50 420 Q200 350 400 440 T840 420" /><path d="M-50 520 Q180 450 390 540 T820 520" />
            <path d="M-50 620 Q160 560 380 640 T800 620" /><path d="M-50 710 Q190 650 400 730 T840 710" />
          </g>
        </svg>

        <div className="relative z-[2] flex items-center gap-[11px]">
          <div className="grid h-9 w-9 place-items-center rounded-[9px]" style={{ background: 'linear-gradient(150deg,var(--brand-lime-deep),var(--brand-deep))' }}>
            <svg viewBox="0 0 24 24" fill="none" className="h-[21px] w-[21px]">
              {/* Classes, not fill=/stroke= attributes: a var() inside a
                  presentation attribute is not reliably resolved, and the mark
                  would fall back to black. Same fix as the sidebar's. */}
              <path d="M12 2L3 6v6c0 5 3.8 8.6 9 10 5.2-1.4 9-5 9-10V6l-9-4z" className="fill-[var(--brand-tint)]" />
              <path d="M9.5 12l1.8 1.8 3.5-3.6" className="stroke-[var(--brand)]" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="font-display text-[16px] font-semibold leading-none text-white">
            Milta<small className="mt-[2px] block text-[9.5px] font-medium uppercase tracking-[.22em] text-[var(--brand-lime-deep)]">Sales CRM</small>
          </div>
        </div>

        {/* The people who read this screen work here — they see it every morning
            and already know what the product is. So it says what the day looks
            like rather than selling it, and the three figures below are facts
            about the CRM they are signing in to, not traction numbers nobody
            can check. The ones that stood here (822K leads routed, 38% average
            connect) were invented, and "4 Timezones" had quietly gone out of
            date: the CRM has covered eight since Alaska and Hawaii were added. */}
        <div className="relative z-[2]">
          <h1 className="mb-[18px] max-w-[15ch] font-display text-[34px] font-semibold leading-[1.07] tracking-tight text-white">
            Everything one call needs, on one screen.
          </h1>
          <p className="max-w-[44ch] text-[14px] text-[var(--brand-lime-soft)]">
            The lead, the dialer, the notes and the follow-up — in the order you work them. Milta routes the queue,
            keeps the customer&apos;s clock, and writes the call up as you go.
          </p>
          <div className="mt-[30px] flex gap-[34px]">
            {[
              ['8', 'Time zones'],
              ['1', 'Operations deck'],
              // Null until the count lands, and the tile is simply left out
              // rather than showing a zero: "0 Users" on a sign-in screen reads
              // as a broken product, and this figure is decoration — it must
              // never be a reason the page looks wrong.
              ...(userCount === null ? [] : [[userCount.toLocaleString(), userCount === 1 ? 'User' : 'Users']]),
            ].map(([n, l]) => (
              <div key={l}>
                <div className="font-display text-[23px] font-semibold text-white">{n}</div>
                <div className="text-[10.5px] uppercase tracking-[.13em] text-[var(--brand-lime)]">{l}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Form side */}
      <div className="flex items-center justify-center bg-white p-10">
        {challenge ? (
          /* ── OTP verification ── the password has been accepted but no token is
             issued until the mailed code is exchanged. */
          <form onSubmit={onVerify} className="w-full max-w-[392px]">
            <h2 className="mb-1.5 font-display text-[23px] font-semibold tracking-tight text-[#14140f]">Verification required</h2>
            <p className="mb-[26px] text-sm text-[var(--tone-neutral-fg)]">
              A 6-digit code was sent to <b className="text-[var(--brand-deep)]">{challenge.sentTo}</b>. Enter it below to finish signing in.
              {challenge.trustDays > 0 && (
                <>
                  {' '}This browser will then be remembered for <b className="text-[var(--brand-deep)]">{challenge.trustDays} days</b> — you
                  won&apos;t be asked for a code again here, even after signing out.
                </>
              )}
            </p>

            <label className="mb-[7px] block text-xs font-semibold text-[var(--brand-deep)]">Verification code</label>
            <input
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              className="w-full rounded-[11px] border-[1.5px] border-[var(--brand-edge)] bg-[var(--tone-neutral-bg)] px-[14px] py-3 text-center font-mono text-[20px] tracking-[.4em] text-[#14140f] outline-none focus:border-[var(--brand-mid)] focus:bg-white focus:ring-4 focus:ring-[var(--brand-surface)]"
            />

            {error && <p className="mt-3 text-sm text-[var(--tone-red-fg)]">{error}</p>}

            <button
              type="submit"
              disabled={loading || code.length !== 6}
              className="mt-[18px] w-full rounded-[11px] bg-[var(--brand)] py-[13px] text-[13.5px] font-semibold text-white shadow-sm transition hover:bg-[var(--brand-deep)] disabled:opacity-60"
            >
              {loading ? 'Verifying…' : 'Verify & sign in'}
            </button>

            <div className="mt-[18px] flex items-center justify-between text-[12.5px]">
              <button
                type="button"
                onClick={onResend}
                disabled={loading || cooldown > 0}
                className="font-semibold text-[var(--brand)] disabled:text-[#93a894]"
              >
                {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
              </button>
              <button
                type="button"
                onClick={() => { setChallenge(null); setCode(''); setError(''); }}
                className="text-[var(--tone-neutral-fg)] hover:underline"
              >
                Back to sign in
              </button>
            </div>
          </form>
        ) : (
        <form onSubmit={onSubmit} className="w-full max-w-[392px]">
          <h2 className="mb-1.5 font-display text-[23px] font-semibold tracking-tight text-[#14140f]">Welcome back</h2>
          <p className="mb-[30px] text-sm text-[var(--tone-neutral-fg)]">Sign in to your operations dashboard.</p>

          <div className="mb-[17px]">
            <label className="mb-[7px] block text-xs font-semibold text-[var(--brand-deep)]">Work email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="w-full rounded-[11px] border-[1.5px] border-[var(--brand-edge)] bg-[var(--tone-neutral-bg)] px-[14px] py-3 text-[#14140f] outline-none focus:border-[var(--brand-mid)] focus:bg-white focus:ring-4 focus:ring-[var(--brand-surface)]"
            />
          </div>

          <div className="mb-[17px]">
            <label className="mb-[7px] block text-xs font-semibold text-[var(--brand-deep)]">Password</label>
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full rounded-[11px] border-[1.5px] border-[var(--brand-edge)] bg-[var(--tone-neutral-bg)] px-[14px] py-3 pr-16 text-[#14140f] outline-none focus:border-[var(--brand-mid)] focus:bg-white focus:ring-4 focus:ring-[var(--brand-surface)]"
              />
              <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-[12.5px] text-[var(--tone-neutral-fg)]">
                {showPw ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          {mfaRequired && (
            <div className="mb-[17px]">
              <label className="mb-[7px] block text-xs font-semibold text-[var(--brand-deep)]">MFA code</label>
              <input
                inputMode="numeric"
                maxLength={6}
                value={mfaToken}
                onChange={(e) => setMfaToken(e.target.value)}
                placeholder="6-digit code"
                className="w-full rounded-[11px] border-[1.5px] border-[var(--brand-edge)] bg-[var(--tone-neutral-bg)] px-[14px] py-3 tracking-widest outline-none focus:border-[var(--brand-mid)] focus:bg-white"
              />
            </div>
          )}

          <div className="my-[18px] flex items-center justify-between text-[12.5px]">
            <label className="flex cursor-pointer items-center gap-2 text-[var(--tone-neutral-fg)]">
              <input type="checkbox" defaultChecked className="h-4 w-4 accent-[var(--brand)]" /> Keep me signed in
            </label>
            <span className="font-semibold text-[var(--brand)]">Forgot password?</span>
          </div>

          {error && <p className="mb-3 text-sm text-[var(--tone-red-fg)]">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-[11px] bg-[var(--brand)] py-[13px] text-[13.5px] font-semibold text-white shadow-sm transition hover:bg-[var(--brand-deep)] disabled:opacity-60"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="my-[22px] flex items-center gap-[14px] text-xs text-[#739175]">
            <span className="h-px flex-1 bg-border" /> or continue with <span className="h-px flex-1 bg-border" />
          </div>
          <button type="button" className="w-full rounded-[11px] border-[1.5px] border-[var(--brand-edge)] bg-white py-3 font-semibold text-[var(--brand-ink)] hover:bg-[var(--tone-neutral-bg)]">
            Single Sign-On (SSO)
          </button>
        </form>
        )}
      </div>
    </main>
  );
}
