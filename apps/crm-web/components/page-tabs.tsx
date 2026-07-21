'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Lets a page render its view tabs up in the topbar, where the page title would
 * otherwise sit.
 *
 * The topbar drops a `<PageTabsSlot />` anchor and a page renders `<PageTabs>`,
 * whose content is portalled into it. A page's first tab names the page (e.g.
 * "Calling Panel"), so while tabs are present the topbar hides its own title
 * rather than printing the same word twice; `useHasPageTabs` reports that.
 * Pages without tabs are untouched — the slot stays empty and the title shows.
 */
const SlotContext = createContext<HTMLElement | null>(null);
const SetSlotContext = createContext<(el: HTMLElement | null) => void>(() => {});
const HasTabsContext = createContext(false);
const SetHasTabsContext = createContext<(v: boolean) => void>(() => {});

export function PageTabsProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [hasTabs, setHasTabs] = useState(false);
  return (
    <SetSlotContext.Provider value={setSlot}>
      <SetHasTabsContext.Provider value={setHasTabs}>
        <SlotContext.Provider value={slot}>
          <HasTabsContext.Provider value={hasTabs}>{children}</HasTabsContext.Provider>
        </SlotContext.Provider>
      </SetHasTabsContext.Provider>
    </SetSlotContext.Provider>
  );
}

/** True while the current page is rendering tabs into the topbar. */
export function useHasPageTabs() {
  return useContext(HasTabsContext);
}

/** The anchor, rendered once by the topbar. */
export function PageTabsSlot({ className = '' }: { className?: string }) {
  const setSlot = useContext(SetSlotContext);
  // `setSlot` is a stable setState, so this callback ref won't thrash.
  return <div ref={setSlot} className={`flex items-center ${className}`} />;
}

/** Renders a page's tabs into the topbar slot. No-ops until the slot mounts. */
export function PageTabs({ children }: { children: ReactNode }) {
  const slot = useContext(SlotContext);
  const setHasTabs = useContext(SetHasTabsContext);

  // Tell the topbar to stand its title down while these tabs are mounted, and
  // to bring it back when the page unmounts. This is the child→ancestor signal
  // React has no other channel for; the flag is derived from mount state only,
  // so it settles in one pass and can't loop.
  useEffect(() => {
    setHasTabs(true);
    return () => setHasTabs(false);
  }, [setHasTabs]);

  if (!slot) return null;
  return createPortal(children, slot);
}
