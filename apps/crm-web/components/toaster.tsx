'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { subscribeToasts, dismissToast, type ToastItem, type ToastKind } from '@/lib/toast';

const STYLE: Record<ToastKind, { icon: typeof Info; bar: string; fg: string }> = {
  success: { icon: CheckCircle2, bar: '#3f7a32', fg: '#2b5423' },
  error: { icon: AlertCircle, bar: '#9e2b21', fg: '#8a2018' },
  info: { icon: Info, bar: '#2c5d8f', fg: '#234a72' },
};

/**
 * App-wide toast stack. Rendered once (in Providers), it subscribes to the
 * module toast store so any component or non-React handler can raise feedback.
 * Docked bottom-center to stay clear of the bottom-right call widgets.
 */
export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return subscribeToasts(setItems);
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-2 px-4"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {items.map((t) => {
        const s = STYLE[t.kind];
        const Icon = s.icon;
        return (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex w-full max-w-[380px] items-start gap-2.5 overflow-hidden rounded-xl border bg-card px-3.5 py-3 shadow-lg"
            style={{ borderInlineStartWidth: 3, borderInlineStartColor: s.bar }}
          >
            <Icon className="mt-px h-[18px] w-[18px] shrink-0" style={{ color: s.bar }} />
            <p className="flex-1 text-[12.5px] leading-snug text-foreground">{t.message}</p>
            <button
              onClick={() => dismissToast(t.id)}
              aria-label="Dismiss notification"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
