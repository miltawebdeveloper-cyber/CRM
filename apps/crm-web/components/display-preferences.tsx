'use client';

import { Check, Clock, Globe, Languages, Loader2 } from 'lucide-react';
import { useDisplaySettings } from '@/components/display-settings-provider';
import { pushToast } from '@/lib/toast';
import { coverage } from '@/lib/i18n';
import {
  DISPLAY_TIMEZONES,
  LANGUAGES,
  formatDateTimeWithZone,
  guessTimezone,
  timezoneLabel,
  type DisplayTimezone,
  type Language,
} from '@/lib/display-settings';

/**
 * The user's own display preferences — time zone and language.
 *
 * Available to every role. There is nothing privileged here: an employee reading
 * timestamps on the wrong clock is the same problem as an admin doing it, so the
 * panel is ungated and the preference is stored per user.
 */
export function DisplayPreferences() {
  const { timezone, language, loading, setTimezone, setLanguage } = useDisplaySettings();
  const browserGuess = guessTimezone();

  const chooseZone = (tz: DisplayTimezone) => {
    setTimezone(tz);
    pushToast('success', `Time zone set to ${timezoneLabel(tz)}. All dates and times now use this clock.`);
  };

  const chooseLanguage = (lang: Language) => {
    setLanguage(lang);
    pushToast('success', `Language set to ${LANGUAGES.find((l) => l.value === lang)?.label ?? lang}.`);
  };

  return (
    <div className="max-w-[760px] space-y-[18px]">
      {/* ── Time zone ── */}
      <section className="rounded-2xl border bg-card p-[18px] shadow-sm">
        <div className="mb-1 flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-display text-[15px] font-semibold">Time Zone</h3>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        <p className="mb-3.5 text-[12.5px] leading-relaxed text-muted-foreground">
          Every date and time in the CRM is shown on this clock — call logs, activity, reports and notifications.
          Saved to your account, so it follows you to any device.
        </p>

        <div className="grid gap-2 sm:grid-cols-2">
          {DISPLAY_TIMEZONES.map((z) => {
            const active = timezone === z.value;
            return (
              <button
                key={z.value}
                onClick={() => chooseZone(z.value)}
                aria-pressed={active}
                className={`flex items-center gap-2.5 rounded-xl border-[1.5px] px-3 py-2.5 text-left transition-colors ${
                  active ? 'border-primary bg-primary/5' : 'hover:bg-muted'
                }`}
              >
                <span className="text-[17px] leading-none">{z.flag}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold">{z.label}</span>
                  <span className="block truncate text-[11.5px] text-muted-foreground">
                    {z.hint}
                    {/* Named so someone who has never chosen can see which one
                        they are already getting, rather than guessing. */}
                    {!active && z.value === browserGuess && ' · detected from your browser'}
                  </span>
                </span>
                {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>

        <div className="mt-3.5 flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2.5">
          <Globe className="mt-[2px] h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="text-[12px] leading-relaxed">
            <div>
              Right now this reads <span className="font-semibold">{formatDateTimeWithZone(new Date())}</span>.
            </div>
            {/* The one exception, stated plainly. Without it, a rep who sets
                their zone to IST and still sees "10:00 AM EDT" on a callback
                reasonably assumes the setting is broken. */}
            <div className="mt-1 text-muted-foreground">
              Scheduled callbacks and meetings also show the customer&apos;s own local time, since that is the hour
              they are expecting the call.
            </div>
          </div>
        </div>
      </section>

      {/* ── Language ── */}
      <section className="rounded-2xl border bg-card p-[18px] shadow-sm">
        <div className="mb-1 flex items-center gap-2">
          <Languages className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-display text-[15px] font-semibold">Language</h3>
        </div>
        <p className="mb-3.5 text-[12.5px] leading-relaxed text-muted-foreground">
          The language the interface is shown in. Saved to your account and applied wherever you sign in.
        </p>

        <div className="grid gap-2 sm:grid-cols-2">
          {LANGUAGES.map((l) => {
            const active = language === l.value;
            const pct = coverage(l.value);
            return (
              <button
                key={l.value}
                onClick={() => l.ready && chooseLanguage(l.value)}
                // Unready languages are shown but not selectable. Hiding them
                // entirely would leave no sign the work is coming; enabling them
                // would drop the user into a half-English screen, which reads as
                // a bug rather than as an unfinished translation.
                disabled={!l.ready}
                aria-pressed={active}
                title={l.ready ? undefined : 'Translation in progress — not yet selectable'}
                className={`flex items-center gap-2.5 rounded-xl border-[1.5px] px-3 py-2.5 text-left transition-colors ${
                  active ? 'border-primary bg-primary/5' : l.ready ? 'hover:bg-muted' : 'opacity-55'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold">{l.native}</span>
                  <span className="block truncate text-[11.5px] text-muted-foreground">
                    {l.label}
                    {!l.ready && ` · ${pct}% translated`}
                  </span>
                </span>
                {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
                {!l.ready && (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-[2px] text-[10.5px] font-semibold text-muted-foreground">
                    Coming soon
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
