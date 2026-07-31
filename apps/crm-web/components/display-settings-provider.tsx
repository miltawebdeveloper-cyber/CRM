'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { loadServerPreferences, saveServerPreference } from '@/lib/preferences';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_KEY,
  TIMEZONE_KEY,
  getUserLanguage,
  getUserTimezone,
  guessTimezone,
  setUserLanguage,
  setUserTimezone,
  type DisplayTimezone,
  type Language,
} from '@/lib/display-settings';

interface DisplaySettings {
  timezone: DisplayTimezone;
  language: Language;
  /** True until the saved preferences have come back from the server. */
  loading: boolean;
  setTimezone: (tz: DisplayTimezone) => void;
  setLanguage: (lang: Language) => void;
}

const Ctx = createContext<DisplaySettings | null>(null);

export function useDisplaySettings(): DisplaySettings {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useDisplaySettings must be used within <DisplaySettingsProvider>');
  return ctx;
}

/**
 * Loads the signed-in user's time zone and language once, publishes them to the
 * module-level state the formatters read, and re-renders the app when either
 * changes.
 *
 * The formatters in `lib/display-settings.ts` are plain functions, not hooks,
 * because much of what needs formatting is not a component — column definitions,
 * export row builders, toast strings. This provider is what keeps those
 * functions truthful: it owns the values, and its state bump is what makes a
 * changed preference repaint the tree rather than sitting stale until reload.
 *
 * Preferences are read from `/me/preferences`, so they survive logout and follow
 * the user to another machine. Until that request lands, the browser's own zone
 * is used as a first guess — it is usually right, and it means no timestamp has
 * to render blank while the network is in flight.
 */
export function DisplaySettingsProvider({ children }: { children: ReactNode }) {
  // Bumped whenever a value changes, purely to re-render consumers.
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // Seed from the browser so first paint is sensible, then let the saved
    // preference overrule it.
    setUserTimezone(guessTimezone());
    void loadServerPreferences().then((prefs) => {
      if (cancelled) return;
      // `?? guessTimezone()` rather than a fixed default: a user who has never
      // opened Settings should still see their own clock, not New York's.
      const zoneChanged = setUserTimezone(prefs[TIMEZONE_KEY] ?? guessTimezone());
      const langChanged = setUserLanguage(prefs[LANGUAGE_KEY] ?? DEFAULT_LANGUAGE);
      setLoading(false);
      if (zoneChanged || langChanged) setVersion((v) => v + 1);
    });
    return () => { cancelled = true; };
  }, []);

  const setTimezone = useCallback((tz: DisplayTimezone) => {
    if (setUserTimezone(tz)) setVersion((v) => v + 1);
    saveServerPreference(TIMEZONE_KEY, tz);
  }, []);

  const setLanguage = useCallback((lang: Language) => {
    if (setUserLanguage(lang)) setVersion((v) => v + 1);
    saveServerPreference(LANGUAGE_KEY, lang);
  }, []);

  const value = useMemo<DisplaySettings>(
    () => ({
      timezone: getUserTimezone(),
      language: getUserLanguage(),
      loading,
      setTimezone,
      setLanguage,
    }),
    // `version` is the dependency that matters: the getters read module state,
    // so the memo has to be rebuilt when that state moves.
    [version, loading, setTimezone, setLanguage],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
