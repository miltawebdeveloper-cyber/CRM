'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

/**
 * A styled confirmation modal — the app's replacement for window.confirm(), which
 * looks foreign, can't say "this can't be undone" in the product's own voice, and
 * gives no busy state while the action runs.
 *
 * `onConfirm` may be async; the dialog shows a spinner and stays open until it
 * settles, then closes. A rejection leaves it open so the error is visible.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = true,
  onConfirm,
  onClose,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);

  // Escape cancels — but not mid-action, so a slow delete can't be half-abandoned.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch {
      setBusy(false); // keep open so the failure toast is seen in context
    }
  };

  return (
    <>
      <div onClick={() => !busy && onClose()} className="fixed inset-0 z-[60] bg-black/40" />
      <div className="fixed inset-0 z-[61] grid place-items-center p-4" role="dialog" aria-modal="true" aria-label={title}>
        <div onClick={(e) => e.stopPropagation()} className="w-full max-w-[400px] overflow-hidden rounded-2xl border bg-card shadow-2xl">
          <div className="flex items-start gap-3 px-5 pt-5">
            <div
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${
                destructive ? 'bg-[#fde9e6] text-[#a8431f]' : 'bg-muted text-foreground'
              }`}
            >
              <AlertTriangle className="h-[18px] w-[18px]" />
            </div>
            <div className="min-w-0">
              <h3 className="font-display text-[14px] font-semibold">{title}</h3>
              <p className="mt-1 text-[12.5px] text-muted-foreground">{message}</p>
            </div>
          </div>
          <div className="mt-5 flex items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">
            <button
              onClick={onClose}
              disabled={busy}
              className="rounded-md border bg-card px-3.5 py-2 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50"
            >
              {cancelLabel}
            </button>
            <button
              onClick={confirm}
              disabled={busy}
              className={`inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-60 ${
                destructive ? 'bg-[#b5372a] hover:bg-[#9e2b21]' : 'bg-primary hover:opacity-90'
              }`}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {busy ? 'Working…' : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
