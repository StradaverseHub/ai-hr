/** AI v2 W2 slice 2 — Edit on a Leave Credit card prepared in chat opens the Leave Credit request dialog on My Leave with
 * the card's date and window (lib/leave-credit-prefill.ts, server-validated by the page), rendered.
 *
 * The prefill only seeds the first row: the dialog opens on arrival with the date and the two times in the very fields the
 * form posts, the First Schedule agreement box is NOT ticked (nothing in the link can tick it), and a malformed, future or
 * agreement-carrying link seeds nothing. The seed leaves the address once used, so a refresh does not reopen the form.
 * Without a prefill the dialog stays closed, as before. Fictional values only. */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { ReplacementLeaveRequestDialog } from '../components/leave/replacement-leave-request-dialog';
import { leaveCreditPrefill, type LeaveCreditPrefill } from '../lib/leave-credit-prefill';

const TYPE = { id: '11111111-1111-4111-8111-111111111111', name: 'Fictional Replacement Leave' };
const TODAY = '2026-11-03';
/** What the roster holds for the seeded date: a rest day, so the row claims a window (the form's own rule). */
const REST_DAY = { kind: 'rest_day' as const, shiftStart: null, shiftEnd: null, actualClockIn: null, actualClockOut: null, measuredExtendedMinutes: 0, approvedOtPlan: null };

function mount(prefill: LeaveCreditPrefill | null, requiresFirstScheduleConsent = true) {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ReplacementLeaveRequestDialog replacementType={TYPE} submitAction={vi.fn()} today={TODAY}
        claimReviewAction={async () => ({ basis: 'legacy' })} dayFactsAction={vi.fn(async () => REST_DAY)}
        tiers={{ extendedHalfDayMinutes: 240, extendedFullDayMinutes: 480, extendedBreakMinutes: 0, extendedGraceMinutes: 0 }}
        ordinaryDayAllowed={false} requiresFirstScheduleConsent={requiresFirstScheduleConsent} prefill={prefill} />
    </NextIntlClientProvider>,
  );
}

describe('the Leave Credit prefill from a chat card\'s Edit', () => {
  it('reads only a well-formed date not after today and two different times, and nothing else', () => {
    const good = { credit: '1', creditDate: '2026-11-01', creditStart: '09:00', creditEnd: '17:00' };
    expect(leaveCreditPrefill(good, TODAY)).toEqual({ workedDate: '2026-11-01', claimStart: '09:00', claimEnd: '17:00' });
    // A window crossing midnight is how a night shift is entered; it is seeded as given.
    expect(leaveCreditPrefill({ ...good, creditStart: '22:00', creditEnd: '02:00' }, TODAY)).toEqual({ workedDate: '2026-11-01', claimStart: '22:00', claimEnd: '02:00' });
    for (const bad of [{ ...good, credit: undefined }, { ...good, credit: 'yes' }, { ...good, creditDate: '2026-11-04' }, { ...good, creditDate: '2026-02-30' },
      { ...good, creditDate: ['2026-11-01'] }, { ...good, creditStart: '9:00' }, { ...good, creditEnd: '24:00' }, { ...good, creditEnd: '09:00' }])
      expect(leaveCreditPrefill(bad as never, TODAY), JSON.stringify(bad)).toBeNull();
    // An agreement in the link is never read: the result has no such field, whatever the link says.
    expect(leaveCreditPrefill({ ...good, firstScheduleConsent: 'on' } as never, TODAY)).toEqual({ workedDate: '2026-11-01', claimStart: '09:00', claimEnd: '17:00' });
  });

  it('opens the dialog on arrival with the date and window in the posted fields, and the agreement box unticked', async () => {
    mount({ workedDate: '2026-11-01', claimStart: '09:00', claimEnd: '17:00' });
    const dialog = screen.getByRole('dialog');
    const posted = () => new FormData(dialog.querySelector('form') as HTMLFormElement);
    expect(posted().getAll('workedDate')).toEqual(['2026-11-01']);
    // The day type fills from the roster, as on the form; then the seeded window is what the row posts.
    await waitFor(() => expect(posted().getAll('dayType')).toEqual(['rest_day']));
    const form = posted();
    expect(form.getAll('claimStart')).toEqual(['09:00']);
    expect(form.getAll('claimEnd')).toEqual(['17:00']);
    const box = dialog.querySelector('input[name="firstScheduleConsent"]') as HTMLInputElement;
    expect(box).not.toBeNull();
    expect(box.checked).toBe(false);
    expect(form.get('firstScheduleConsent')).toBeNull();
    expect(dialog).toHaveTextContent(en.replacementRequest.firstScheduleConsent);
    // The reason is the person's own: never seeded.
    expect(form.get('reason')).toBe('');
  });

  it('strips the seed from the address once the dialog has opened on it, keeping every other parameter', () => {
    window.history.replaceState(null, '', '/leave?leaveYear=2026&credit=1&creditDate=2026-11-01&creditStart=09%3A00&creditEnd=17%3A00#apply');
    mount({ workedDate: '2026-11-01', claimStart: '09:00', claimEnd: '17:00' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/leave?leaveYear=2026#apply');
    window.history.replaceState(null, '', '/');
  });

  it('stays closed without a prefill, as before', () => {
    mount(null);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
