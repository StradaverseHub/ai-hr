/**
 * r219 (7966ee35) — THE RENDER CHECK for "why Replacement Leave in Lieu is not available", in all six
 * locales and for both audiences.
 *
 * WHY A RENDER AND NOT A KEY CHECK. Every sentence this component prints is resolved through a map indexed
 * by the REASON (`REPLACEMENT_UNAVAILABLE_COPY`), and three of its placeholders are pulled from OTHER
 * namespaces — the settings screen's own switch captions and the sidebar's own menu path, so a sentence
 * telling an administrator to switch something on cannot call that switch a name the screen does not use.
 * A dynamic key and a cross-namespace interpolation are exactly the two shapes every static check in this
 * repo is blind to: a missing one paints `MISSING_MESSAGE` in the browser and still returns 200, passes
 * tsc, passes the suite and passes `next build` (AGENTS rule 6). Only a render sees it.
 *
 * ALSO PINNED HERE, and not statically assertable anywhere:
 *   · the ALLOWED path renders NOTHING unless the First Schedule consent is in play — so a page may mount
 *     this on the availability alone and the ordinary employee's screen is unchanged;
 *   · `audience` changes only the SUBJECT of the sentence, never which cause is named. An employee ringing
 *     HR and the HR admin looking that person up must be told the same thing;
 *   · the control captions reach the sentence VERBATIM from the config screen's own catalogue entries, so
 *     a renamed switch renames itself inside every sentence that points at it.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

import { ReplacementAvailabilityNotice } from '../components/leave/replacement-availability-notice';
import {
  REPLACEMENT_UNAVAILABLE_COPY,
  type ReplacementUnavailableReason,
} from '../lib/replacement-availability';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];

/** Every reason the union can hold — from the map itself, so a sixth added without copy fails at the RENDER. */
const ALL_REASONS = Object.keys(REPLACEMENT_UNAVAILABLE_COPY) as ReplacementUnavailableReason[];

/** next-intl paints the key path when a key does not resolve; a bare key leaking into the DOM is the same
 *  defect wearing a different hat, and so is a raw reason enum reaching a customer's screen. */
const looksUnresolved = (text: string) =>
  /MISSING_MESSAGE/.test(text) ||
  /replacementRequest\./.test(text) ||
  /\bunavailable\.[a-zA-Z]/.test(text) ||
  /\bconsentNotice\.[a-zA-Z]/.test(text) ||
  ALL_REASONS.some((r) => text.includes(r));

function renderNotice(
  locale: Locale,
  availability: { allowed: boolean; reason?: ReplacementUnavailableReason; requiresFirstScheduleConsent?: boolean },
  audience: 'self' | 'admin',
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}>
      <ReplacementAvailabilityNotice availability={availability} audience={audience} />
    </NextIntlClientProvider>,
  );
}

const policyCopy = (locale: Locale) =>
  (CATALOGUES[locale] as unknown as { admin: { replacementLeave: Record<string, string> } }).admin.replacementLeave;
const navCopy = (locale: Locale) => (CATALOGUES[locale] as unknown as { nav: Record<string, string> }).nav;

describe('r219: every reason says something, in every locale, to both audiences', () => {
  for (const locale of LOCALES) {
    for (const audience of ['self', 'admin'] as const) {
      it(`[${locale}/${audience}] every reason renders a resolved title and body`, () => {
        for (const reason of ALL_REASONS) {
          const { unmount } = renderNotice(locale, { allowed: false, reason }, audience);
          const box = screen.getByRole('status');
          const text = box.textContent ?? '';
          expect(looksUnresolved(text), `${locale}/${audience}/${reason} unresolved: ${text.slice(0, 120)}`).toBe(false);
          // Two lines, not one: the title names the cause and the body says what to do about it (or, for
          // the account-level ones, that there is nothing on this screen to do).
          expect(box.querySelectorAll('p').length, `${locale}/${audience}/${reason} shape`).toBe(2);
          expect(text.length, `${locale}/${audience}/${reason} empty`).toBeGreaterThan(20);
          unmount();
        }
      });
    }

    it(`[${locale}] the switches an administrator is sent to are named from the settings screen's own words`, () => {
      // The whole value of "Replacement leave is switched off for this company" is the next sentence
      // telling you which two controls to look at. Minting a second set of names for them under this
      // namespace is how r127 shipped a screen that rendered entirely through MISSING_MESSAGE.
      const p = policyCopy(locale);
      const nav = navCopy(locale);
      const notEnabled = renderNotice(locale, { allowed: false, reason: 'not_enabled' }, 'admin');
      const offText = screen.getByRole('status').textContent ?? '';
      expect(offText, `${locale} enable switch`).toContain(p.enabledLabel);
      expect(offText, `${locale} menu path`).toContain(nav.leaveConfig);
      // 3fb1a611 (r299) — the switches are on Leave Config › Leave Credit (Rules tab) now, and the sentence
      // names that screen by the sidebar row's own label.
      expect(offText, `${locale} screen name`).toContain(nav.leaveCredit);
      // …and NOT the other switch. r219 split these two states apart precisely so each sentence points at
      // ONE control; naming both again would restore the "one of these is off" guess it replaced.
      expect(offText, `${locale} not_enabled names the wrong switch too`).not.toContain(p.employeeRequestLabel);
      notEnabled.unmount();

      const requestsOff = renderNotice(locale, { allowed: false, reason: 'employee_requests_off' }, 'admin');
      const requestsOffText = screen.getByRole('status').textContent ?? '';
      expect(requestsOffText, `${locale} employee-request switch`).toContain(p.employeeRequestLabel);
      expect(requestsOffText, `${locale} menu path`).toContain(nav.leaveConfig);
      requestsOff.unmount();

      const fs = renderNotice(locale, { allowed: false, reason: 'first_schedule_protected' }, 'admin');
      const fsText = screen.getByRole('status').textContent ?? '';
      expect(fsText, `${locale} First Schedule switch`).toContain(p.allowEligibleLabel);
      fs.unmount();

      const elig = renderNotice(locale, { allowed: false, reason: 'not_eligible' }, 'admin');
      const eligText = screen.getByRole('status').textContent ?? '';
      expect(eligText, `${locale} eligibility section`).toContain(p.eligibilityTitle);
      elig.unmount();
    });

    it(`[${locale}] the First Schedule consent note renders on the ALLOWED path`, () => {
      const { unmount } = renderNotice(locale, { allowed: true, requiresFirstScheduleConsent: true }, 'self');
      const text = screen.getByRole('status').textContent ?? '';
      expect(looksUnresolved(text), `${locale} consent unresolved`).toBe(false);
      expect(text.length).toBeGreaterThan(20);
      unmount();
    });
  }

  it('the two person-shaped reasons say something DIFFERENT to HR than to the employee', () => {
    // Same cause, different subject. If these two ever came back identical it would mean the admin key had
    // silently fallen back to the employee's second-person wording, which is the sentence HR must not read
    // on a screen that is about somebody else.
    for (const reason of ['not_eligible', 'first_schedule_protected'] as const) {
      const self = renderNotice('en', { allowed: false, reason }, 'self');
      const selfText = screen.getByRole('status').textContent ?? '';
      self.unmount();
      const admin = renderNotice('en', { allowed: false, reason }, 'admin');
      const adminText = screen.getByRole('status').textContent ?? '';
      admin.unmount();
      expect(selfText, `${reason} subject`).not.toEqual(adminText);
      // Case-folded: one of the two admin sentences opens with the subject, the other carries it mid-clause.
      expect(adminText.toLowerCase(), `${reason} admin wording`).toContain('this employee');
    }
  });

  it('the account-level reasons say the SAME thing to both, and it is one sentence to keep in step', () => {
    for (const reason of ['module_off', 'not_enabled', 'employee_requests_off', 'no_employment'] as const) {
      const self = renderNotice('en', { allowed: false, reason }, 'self');
      const selfText = screen.getByRole('status').textContent ?? '';
      self.unmount();
      const admin = renderNotice('en', { allowed: false, reason }, 'admin');
      const adminText = screen.getByRole('status').textContent ?? '';
      admin.unmount();
      expect(selfText, `${reason}`).toEqual(adminText);
    }
  });

  it('module_off does not promise a date and does not send anyone to a setting', () => {
    // The plan tells the reporter the add-on is being provisioned; the SCREEN must not repeat a promise it
    // cannot keep or point at a switch that could never have changed the answer (AGENTS rule 28's spirit:
    // a caption asserting something that is not always true is worse than the gap it filled).
    const { unmount } = renderNotice('en', { allowed: false, reason: 'module_off' }, 'admin');
    const text = (screen.getByRole('status').textContent ?? '').toLowerCase();
    for (const forbidden of ['contact support', 'shortly', 'within', 'will be enabled', 'coming soon']) {
      expect(text, `module_off promises "${forbidden}"`).not.toContain(forbidden);
    }
    unmount();
  });

  it('an ALLOWED employee with nothing to warn about is shown nothing at all', () => {
    // The ordinary case, and the reason a page may mount this unconditionally: before this item the screen
    // rendered nothing here, and for everyone who can actually submit it still does.
    const { container, unmount } = renderNotice('en', { allowed: true }, 'self');
    expect(container.innerHTML).toBe('');
    unmount();
    const admin = renderNotice('en', { allowed: true, requiresFirstScheduleConsent: false }, 'admin');
    expect(admin.container.innerHTML).toBe('');
    admin.unmount();
  });

  it('a refusal with no reason renders nothing rather than an unexplained box', () => {
    // An empty "unavailable" box is the defect this whole item exists to end — it would be the silence the
    // reporter already lived through, wearing a border.
    const { container, unmount } = renderNotice('en', { allowed: false }, 'self');
    expect(container.innerHTML).toBe('');
    unmount();
  });
});
