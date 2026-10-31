import { countryPacks } from '@/localization/registry';

/**
 * def44f29 — the National / State vocabulary the holiday dialog offers, per ISO country code, from the
 * registered country packs (rung 5b, D6: the same source components/holiday-group-form.tsx validates
 * against). The WHOLE list, in the pack's declared order: the reporter's dropdown is "National plus the
 * 16 states and territories", and a slice or a filter here would be a screen quietly offering fewer.
 * test/holiday-dialog-shape.test.ts calls this and compares it with the pack's own list, entry for entry.
 *
 * A separate module rather than a helper inside page.tsx because Next allows a page file no extra
 * exports, and a list this small is not worth being unpinnable.
 */
export function holidayStatesByCountry(): Record<string, string[]> {
  return Object.fromEntries(countryPacks().map((p) => [p.country, [...p.states]]));
}
