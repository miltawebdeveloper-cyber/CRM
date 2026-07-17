// Framework-agnostic toast store. A module singleton so non-React code — e.g.
// the React Query MutationCache handler in providers.tsx — can raise toasts the
// same way components do. The <Toaster> component subscribes and renders.

export type ToastKind = 'success' | 'error' | 'info';
export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

type Listener = (items: ToastItem[]) => void;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l(items));

/** Raise a toast. `ttl` ms until auto-dismiss (0 = sticky). Returns its id. */
export function pushToast(kind: ToastKind, message: string, ttl = 4200): number {
  const id = nextId++;
  items = [...items, { id, kind, message }];
  emit();
  if (ttl > 0 && typeof window !== 'undefined') window.setTimeout(() => dismissToast(id), ttl);
  return id;
}

export function dismissToast(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

/** Subscribe to the toast list; the listener fires immediately with current state. */
export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(items);
  return () => { listeners.delete(listener); };
}

export const toast = {
  success: (message: string, ttl?: number) => pushToast('success', message, ttl),
  error: (message: string, ttl?: number) => pushToast('error', message, ttl),
  info: (message: string, ttl?: number) => pushToast('info', message, ttl),
};
