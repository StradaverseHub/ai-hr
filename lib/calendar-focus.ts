/**
 * Manager Leave Summary → Leave Calendar deep link (item 726ac8c2).
 *
 * The Leave Summary section on a subordinate's Personnel profile carries a "View Calendar" action that
 * lands on the dashboard's Leave Calendar in Team view with that employee highlighted. Both ends of the
 * link live here — the builder the profile renders and the parser the dashboard validates with — so a
 * renamed param can never degrade the feature into a silent no-op (the grid's missing-row branch would
 * swallow it exactly as the approvals arrival island swallows a missing section).
 *
 * The calendar keys its rows by PERSON id (a person with two concurrent employments merges into one
 * row), so that — not the employment id — is what travels in the link.
 */

/** Query param carrying the person to highlight. */
export const CALENDAR_FOCUS_PARAM = 'focus';

/** How long the highlight stays on. The reporter asked for 3 seconds. */
export const CALENDAR_FOCUS_MS = 3000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The dashboard href that opens the Leave Calendar on the team view with `personId` highlighted.
 * `#planned-absences` is the calendar card's own id, so the browser's native anchor jump does the
 * scrolling — no client island needed for that half.
 */
export function buildCalendarFocusHref(personId: string): string {
  const params = new URLSearchParams({ view: 'team', [CALENDAR_FOCUS_PARAM]: personId });
  return `/?${params.toString()}#planned-absences`;
}

/** The validated focus person id from a search param, or null. Junk is dropped rather than rendered. */
export function parseCalendarFocus(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && UUID_RE.test(value) ? value : null;
}
