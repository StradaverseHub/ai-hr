/**
 * The per-Schedule-Group screen's SECTION keys, in the order the reporter listed them (feedback 1c5602cc,
 * extended by 665de026).
 *
 * A PLAIN, NON-'use client' MODULE ON PURPOSE. The pages are Server Components and READ this list; importing
 * a value from a 'use client' shell and using it on the server is the exact class test/rsc-boundary-guard.
 * test.ts exists to catch (a live P0 once — b7d84266).
 *
 * ══ 665de026 (r331) — THIS WAS `tabs.ts`, AND ITS HEADER HAD GONE STALE ═══════════════════════════════════
 * The retired file said "⚠️ ONLY `general` HAS A PANEL. The other five are NAMED, EMPTY tabs". That was true
 * when r263 wrote it and r277 made it FALSE: `page.tsx` has rendered `panels={{ general, attendance,
 * overtime }}` since then — THREE panels, not one. A comment that describes a screen's shape is a claim, and
 * this one had been wrong for two rounds. It is restated below against what is on disk, and the file is
 * renamed because these are not tabs any more: one Schedule Group is ONE SCROLLING PAGE, so each key is a
 * section heading and an anchor id, not a tab.
 *
 * ⚠️ WHAT IS ACTUALLY BEHIND EACH KEY, measured 2026-09-23. FOUR of the seven are real:
 *
 *   · general       — the Schedule Group's own identity: name, description, status, allowed shifts, the
 *                     deduction switch and the overtime ladder. `rules/rule-form.tsx`, unchanged.
 *                     ⚠️ It is NOT the old General TAB. Four of that tab's five cards belong to the TENANT
 *                     or to a COMPANY, not to a Schedule Group, so they stayed on the list page — see
 *                     docs/audits/665de026-schedule-save-classification.md §5.
 *   · overtime      — the before-shift overtime switch and each band's rounding (r277). Real, stored.
 *   · attendance    — the grace periods and the two "after N, record M" pairs (r277). Real, stored.
 *   · workingDay    — 07ebd04d (r331, migration 0483) put weekly_pattern / half_pattern / off_pattern on
 *                     `attendance_rule` with two CHECK constraints, and core/attendance-rule.ts has both
 *                     exposed and validated them since. NO SCREEN READ OR EDITED THEM until this one. It is
 *                     the only genuinely new section in 665de026; everything else is relocation.
 *
 * THREE ARE NAMED AND EMPTY, ON PURPOSE, and they are not placeholders for settings that exist:
 *
 *   · holiday · request · notification
 *
 * Adding a key here without a section is fine and honest; adding a CONTROL for a setting nothing stores is
 * not. The list page's own header names the settings that are NOT STORED ANYWHERE (rotation, the duty-roster
 * controls, the monthly OT cap) and the reason each is absent.
 */
import { scheduleGroupViewPath } from '../../attendance-policy/schedule-panel';

export const SCHEDULE_SECTION_KEYS = [
  'general',
  // r429 (f6819e19) · D7 — WORKING DAY MOVES TO SECOND. It used to be listed seventh, appended after
  // 07ebd04d gave it storage; this round makes it the section the reporter now opens the page FOR — the
  // Shift page's own week row is retired (D1), so this is the only place a working week is set at all —
  // and asks it to carry the live "Shifts in this group" preview beside it. The other five keep their
  // relative order.
  'workingDay',
  'holiday',
  'overtime',
  'attendance',
  'request',
  'notification',
] as const;

export type ScheduleSectionKey = (typeof SCHEDULE_SECTION_KEYS)[number];

/** The sections that render a control or a value. The rest render the "not built yet" line. */
export const SCHEDULE_BUILT_SECTIONS = ['general', 'overtime', 'attendance', 'workingDay'] as const;

/** One section's anchor on the per-group page, so a save can return the reader to the section they saved. */
export const sectionAnchor = (key: ScheduleSectionKey) => `section-${key}`;

/**
 * aec53564 (r331) — A LINK (not a redirect) to one Schedule Group's page, landing on one section.
 *
 * ⚠️ THE SECTION IS A QUERY PARAMETER **AND** A FRAGMENT, IN THAT ORDER, AND NEVER IN FRONT OF A QUERY
 * KEY. `okScheduleGroup` / `failScheduleGroup` (app/admin/_redirects.ts) append `&section=` AFTER their
 * `?toast=` / `?error=` key for exactly this reason: `…?section=workingDay?toast=Saved` reads `section` as
 * "workingDay?toast=Saved" and loses the toast, and that defect shipped TWICE on this screen (r287 → r301,
 * on `?tab=`). A link carries no toast, so `section` is the FIRST and ONLY query key here — and it is
 * built HERE, once, rather than spelled out at a call site where the next parameter added would be
 * concatenated in front of it. Nothing else on this screen may build a schedule URL by hand.
 *
 * The VIEW page, not Edit: a link offered beside a control the reader cannot change is an invitation to
 * see what decides it, and View is the page that answers that without putting them in an editor they did
 * not ask for. Its own header carries "Edit this Schedule Group" for the step after.
 */
export const scheduleGroupSectionHref = (ruleId: string, section: ScheduleSectionKey): string =>
  `${scheduleGroupViewPath(ruleId)}?section=${encodeURIComponent(section)}#${sectionAnchor(section)}`;

/**
 * `[ruleId]` IS AN UNTRUSTED URL SEGMENT AND `attendance_rule.id` IS A UUID COLUMN.
 *
 * Its shape is checked BEFORE any query. The r263 verifier found the 500 this prevents on the sibling
 * screen: junk reached `eq(employment.id, …)` and Postgres threw "invalid input syntax for type uuid".
 * Junk and an unknown id then render the SAME sentence with the back link — never notFound(), never a
 * crash: a stale bookmark is told its Schedule Group is not on this list.
 */
export const RULE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?section=` read by VALUE against the closed key list, exactly as `?tab=` was. Junk ⇒ no section. */
export function resolveSection(raw: string | undefined): ScheduleSectionKey | null {
  return (SCHEDULE_SECTION_KEYS as readonly string[]).includes(raw ?? '') ? (raw as ScheduleSectionKey) : null;
}
