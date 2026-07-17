'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, tokenStore } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('admin@crm.local');
  const [password, setPassword] = useState('Passw0rd!');
  const [showPw, setShowPw] = useState(false);
  const [mfaToken, setMfaToken] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
      tokenStore.set(data.accessToken, data.refreshToken);
      router.push('/dashboard');
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-screen md:grid-cols-[1.05fr_.95fr]" style={{ background: '#112712' }}>
      {/* Brand side */}
      <div
        className="relative hidden flex-col justify-between overflow-hidden p-[54px_60px] text-[#eef6ef] md:flex"
        style={{
          background:
            'radial-gradient(120% 90% at 0% 0%,rgba(111,135,69,.55),transparent 55%),radial-gradient(130% 100% at 100% 100%,rgba(28,35,22,.9),transparent 60%),linear-gradient(160deg,#183e1a,#112712 70%)',
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
          <div className="grid h-9 w-9 place-items-center rounded-[9px]" style={{ background: 'linear-gradient(150deg,#7e9933,#1d491f)' }}>
            <svg viewBox="0 0 24 24" fill="none" className="h-[21px] w-[21px]">
              <path d="M12 2L3 6v6c0 5 3.8 8.6 9 10 5.2-1.4 9-5 9-10V6l-9-4z" fill="#d8eed9" />
              <path d="M9.5 12l1.8 1.8 3.5-3.6" stroke="#266929" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="font-display text-[18px] font-semibold leading-none text-white">
            Milta<small className="mt-[2px] block text-[9.5px] font-medium uppercase tracking-[.22em] text-[#7e9933]">Sales CRM</small>
          </div>
        </div>

        <div className="relative z-[2]">
          <h1 className="mb-[18px] max-w-[13ch] font-display text-[40px] font-semibold leading-[1.07] tracking-tight text-white">
            Command your pipeline. Close on every call.
          </h1>
          <p className="max-w-[42ch] text-[15px] text-[#c7d69f]">
            The calling-first CRM built for high-tempo outbound teams — lead routing, live dialer, productivity tracking, and AI coaching in one operations deck.
          </p>
          <div className="mt-[30px] flex gap-[34px]">
            {[['822K', 'Leads routed'], ['38%', 'Avg. connect'], ['4', 'Timezones']].map(([n, l]) => (
              <div key={l}>
                <div className="font-display text-[26px] font-semibold text-white">{n}</div>
                <div className="text-[11px] uppercase tracking-[.13em] text-[#a6c74d]">{l}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Form side */}
      <div className="flex items-center justify-center bg-white p-10">
        <form onSubmit={onSubmit} className="w-full max-w-[392px]">
          <h2 className="mb-1.5 font-display text-[26px] font-semibold tracking-tight text-[#0c120d]">Welcome back</h2>
          <p className="mb-[30px] text-sm text-[#5a725b]">Sign in to your operations dashboard.</p>

          <div className="mb-[17px]">
            <label className="mb-[7px] block text-xs font-semibold text-[#1d491f]">Work email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-[11px] border-[1.5px] border-[#bbd3bc] bg-[#f5faf5] px-[14px] py-3 text-[#0c120d] outline-none focus:border-[#2b732f] focus:bg-white focus:ring-4 focus:ring-[#d8eed9]"
            />
          </div>

          <div className="mb-[17px]">
            <label className="mb-[7px] block text-xs font-semibold text-[#1d491f]">Password</label>
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full rounded-[11px] border-[1.5px] border-[#bbd3bc] bg-[#f5faf5] px-[14px] py-3 pr-16 text-[#0c120d] outline-none focus:border-[#2b732f] focus:bg-white focus:ring-4 focus:ring-[#d8eed9]"
              />
              <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-[13px] text-[#5a725b]">
                {showPw ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          {mfaRequired && (
            <div className="mb-[17px]">
              <label className="mb-[7px] block text-xs font-semibold text-[#1d491f]">MFA code</label>
              <input
                inputMode="numeric"
                maxLength={6}
                value={mfaToken}
                onChange={(e) => setMfaToken(e.target.value)}
                placeholder="6-digit code"
                className="w-full rounded-[11px] border-[1.5px] border-[#bbd3bc] bg-[#f5faf5] px-[14px] py-3 tracking-widest outline-none focus:border-[#2b732f] focus:bg-white"
              />
            </div>
          )}

          <div className="my-[18px] flex items-center justify-between text-[13px]">
            <label className="flex cursor-pointer items-center gap-2 text-[#5a725b]">
              <input type="checkbox" defaultChecked className="h-4 w-4 accent-[#266929]" /> Keep me signed in
            </label>
            <span className="font-semibold text-[#266929]">Forgot password?</span>
          </div>

          {error && <p className="mb-3 text-sm text-[#9e2b21]">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-[11px] bg-[#266929] py-[13px] text-[14.5px] font-semibold text-white shadow-sm transition hover:bg-[#1d491f] disabled:opacity-60"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="my-[22px] flex items-center gap-[14px] text-xs text-[#739175]">
            <span className="h-px flex-1 bg-[#d7e5d7]" /> or continue with <span className="h-px flex-1 bg-[#d7e5d7]" />
          </div>
          <button type="button" className="w-full rounded-[11px] border-[1.5px] border-[#bbd3bc] bg-white py-3 font-semibold text-[#163618] hover:bg-[#eef6ef]">
            Single Sign-On (SSO)
          </button>

          <div className="mt-[22px] rounded-[11px] border border-dashed border-[#a6c74d] bg-[#eef6ef] px-[14px] py-[11px] text-xs text-[#1d491f]">
            ▸ Prototype mode — credentials are pre-filled with a working demo account. Click <b>Sign in</b> to explore.
          </div>
        </form>
      </div>
    </main>
  );
}
