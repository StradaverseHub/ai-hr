'use client';

/**
 * r219 (7966ee35) — "Replacement Leave in Lieu Option Not Available", answered on the screen.
 *
 * WHERE THE BUTTON WOULD BE, THE REASON. `replacementRequestAvailability` decides whether an employee may
 * ask to be credited for time they already worked, and it has always returned WHY it said no. Both
 * surfaces that asked it — the employee's own My Absence page and HR's Employee Balances view of that same
 * employee — branched on the boolean and rendered nothing at all, so "the option is not available" was the
 * whole of what anyone could learn. The reporter turned every Leave config switch on, twice, against a
 * cause that sits ABOVE Leave config and could not be reached from there.
 *
 * ONE COMPONENT FOR BOTH AUDIENCES, and that is load-bearing rather than a convenience: the employee and
 * the HR admin looking at that employee must be told the same cause. Two `if` ladders over one object is
 * how `no_eligibility_match` (8ebf77ae) came to have an admin panel and an employee panel describing one
 * configuration two different ways. `audience` selects only the SUBJECT of the sentence ("you" / "this
 * employee"), never which cause is named.
 *
 * ⚠️ THE CONTROLS ARE NAMED FROM THE CONFIG SCREEN'S OWN VOCABULARY, NEVER RETYPED. A sentence telling an
 * administrator to switch something on is worthless if it calls that switch something the screen does not.
 * The switch captions and the menu path are interpolated from the keys the settings screen and the sidebar
 * actually render (`admin.replacementLeave.*`, `nav.*`) — the same discipline r212 applied to the
 * eligibility axis names, and minting a second set of names under this namespace is how r127 shipped a
 * screen that rendered entirely through `MISSING_MESSAGE` behind a green 200.
 *
 * NOTHING IS RE-DERIVED HERE. The verdict arrives already decided as plain serialisable data; this file
 * maps a reason to a sentence and paints a box. It renders NULL when there is nothing to say, so a caller
 * can mount it on the availability alone.
 *
 * VISUAL PARITY with the entitlement-status notice in LeaveDetailsPanel.tsx (`role="status"`, amber) — the
 * two answer the same shape of question on the same screens, and a second visual vocabulary for "here is
 * why the thing you expected is missing" would read as a different kind of thing.
 *
 * Substrate: read-only presentation → NO DomainEvent. // substrate: read-only, no event
 */
import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';
import {
  REPLACEMENT_CONSENT_NOTICE,
  REPLACEMENT_UNAVAILABLE_COPY,
  type ReplacementUnavailableReason,
} from '@/lib/replacement-availability';

/** Whose leave is on screen — the signed-in employee's own, or an employee HR is looking up. */
export type ReplacementNoticeAudience = 'self' | 'admin';

export function ReplacementAvailabilityNotice({
  availability,
  audience,
}: {
  /**
   * The already-resolved verdict. Deliberately structural rather than the service's own type: this is a
   * client component and `packs/leave/service` drags in `db/client`, so the shape is restated while the
   * REASON union is imported from `lib/replacement-availability` — the same module the service types its
   * own `reason` from, so the two cannot drift apart without failing to typecheck.
   */
  availability: { allowed: boolean; reason?: ReplacementUnavailableReason; requiresFirstScheduleConsent?: boolean };
  audience: ReplacementNoticeAudience;
}) {
  const t = useTranslations('replacementRequest');
  // The settings screen's own captions and the sidebar's own path. See the header: these are read, never
  // retyped, so a renamed switch renames itself inside every sentence that points at it.
  const tPolicy = useTranslations('admin.replacementLeave');
  const tNav = useTranslations('nav');
  const controls = {
    config: tNav('leaveConfig'),
    // 3fb1a611 (r299) — the replacement-leave switches live on Leave Config › Leave Credit (Rules tab) now.
    screen: tNav('leaveCredit'),
    enableSwitch: tPolicy('enabledLabel'),
    requestSwitch: tPolicy('employeeRequestLabel'),
    allowSwitch: tPolicy('allowEligibleLabel'),
    eligibilitySection: tPolicy('eligibilityTitle'),
  };

  // ALLOWED — one thing may still be worth saying, and only one. An employee inside the First Schedule
  // whose company HAS switched the override on gets the button, and the form will ask them to trade the
  // statutory overtime cash for banked time. That is a legal position, not a preference, so it is named
  // before the form is opened rather than discovered inside it.
  if (availability.allowed) {
    if (!availability.requiresFirstScheduleConsent) return null;
    return (
      <div
        role="status"
        className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
      >
        <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <span className="block font-medium text-foreground">{t(REPLACEMENT_CONSENT_NOTICE.title, controls)}</span>
          <span className="mt-0.5 block">
            {t(
              audience === 'admin' ? REPLACEMENT_CONSENT_NOTICE.bodyAdmin : REPLACEMENT_CONSENT_NOTICE.body,
              controls,
            )}
          </span>
        </span>
      </div>
    );
  }

  // REFUSED, but the caller has no reason to give (it never asked the service — an admin page with no
  // employee selected, say). An unexplained box is the defect this file exists to end, so it renders
  // nothing rather than a generic "unavailable".
  const reason = availability.reason;
  if (!reason) return null;
  const copy = REPLACEMENT_UNAVAILABLE_COPY[reason];

  return (
    <div
      role="status"
      className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <p className="font-medium">{t(copy.title, controls)}</p>
      <p className="mt-0.5">{t(audience === 'admin' && copy.bodyAdmin ? copy.bodyAdmin : copy.body, controls)}</p>
    </div>
  );
}
