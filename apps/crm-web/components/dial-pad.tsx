'use client';

import { useState } from 'react';
import { Phone, Delete } from 'lucide-react';
import { useCall } from '@/components/call-provider';
import { useCanCall } from '@/lib/use-can-call';

const KEYS = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
  ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
  ['*', ''], ['0', '+'], ['#', ''],
] as const;

/**
 * Numeric dial pad — punch in any number and call it via the in-CRM widget.
 *
 * `disabled` lets a host that runs its own call flow (the Calling Panel) block
 * dialling while ITS call is live, so the two can't put the agent on two calls
 * at once.
 */
export function DialPad({ className = '', disabled = false }: { className?: string; disabled?: boolean }) {
  const { placeCallNumber, active } = useCall();
  const { dial, callingEnabled, disabledReason } = useCanCall();
  const [num, setNum] = useState('');

  // Lead-processing mode: the pad stays on the page (nothing is removed) but it
  // cannot dial, and it says why rather than failing on click.
  const busy = active || disabled || !callingEnabled;
  const press = (k: string) => setNum((n) => (n.length < 20 ? n + k : n));
  const back = () => setNum((n) => n.slice(0, -1));
  // Hand the number to the Quo app here in the click, then log/monitor via the
  // widget. `dial` guards FIRST: without a caller ID the API will refuse to log
  // the call, and dialling anyway would put a real call through that the CRM
  // never records.
  const call = () => {
    if (!num.trim() || busy) return;
    if (!dial(num.trim())) return;
    placeCallNumber(num.trim());
  };

  return (
    <div className={`rounded-2xl border bg-card p-4 shadow-sm ${className}`}>
      <div className="mb-1 text-[13px] font-semibold text-muted-foreground">Dial pad</div>
      {!callingEnabled && (
        <p className="mb-2 rounded-md bg-muted px-2.5 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
          {disabledReason || 'Calling is temporarily disabled.'}
        </p>
      )}
      <input
        value={num}
        onChange={(e) => setNum(e.target.value.replace(/[^\d+*#]/g, ''))}
        onKeyDown={(e) => { if (e.key === 'Enter') call(); }}
        placeholder="Enter number"
        inputMode="tel"
        className="mb-3 w-full rounded-lg border bg-background px-3 py-2.5 text-center font-mono text-[18px] tracking-wide outline-none focus:ring-2 focus:ring-primary/30"
      />
      <div className="grid grid-cols-3 gap-2">
        {KEYS.map(([k, sub]) => (
          <button
            key={k}
            onClick={() => press(k)}
            className="flex flex-col items-center justify-center rounded-xl border bg-card py-2.5 hover:bg-muted active:scale-95"
          >
            <span className="font-display text-[19px] font-semibold leading-none">{k}</span>
            {sub && <span className="mt-0.5 text-[9px] font-semibold tracking-widest text-muted-foreground">{sub}</span>}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={call}
          disabled={!num.trim() || busy}
          title={!callingEnabled ? disabledReason || 'Calling is temporarily disabled' : disabled && !active ? 'Finish the call in the panel first' : undefined}
          className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#317d34] py-3 text-[14px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          <Phone className="h-4 w-4" /> {!callingEnabled ? 'Calling disabled' : busy ? 'On call…' : 'Call'}
        </button>
        <button
          onClick={back}
          disabled={!num}
          title="Delete"
          aria-label="Delete last digit"
          className="grid h-[46px] w-[46px] place-items-center rounded-xl border text-muted-foreground hover:bg-muted disabled:opacity-40"
        >
          <Delete className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
