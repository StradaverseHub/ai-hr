/**
 * 3fb1a611 (r279) — "Expiring soon" on the employee's own Replacement Leave card.
 *
 * The reporter's last point on this screen: show which credits are about to be lost, so one is USED rather
 * than quietly forfeited. Pure presentation — every field it reads (`status`, `remaining`, `expiresOn`) has
 * ridden on each row since 0113 and `asOf` was already a prop — so this renders the real panel and asserts
 * what a reader SEES, which is the only thing that can be wrong about it.
 *
 * THE FOUR CASES THAT MATTER are the four ways a row can fail to be "expiring soon", and three of them are
 * easy to get wrong by writing `expiresOn <= asOf + 30` and stopping:
 *   · inside the window and still spendable  ⇒ flagged;
 *   · outside the window                     ⇒ not flagged;
 *   · ALREADY PAST its expiry                ⇒ not flagged (it has expired; "soon" would be a lie);
 *   · spent, lapsed or paid out              ⇒ not flagged (there is nothing left to lose).
 *
 * Dates are fixed here, deliberately and unlike the service tests: `asOf` is an explicit PROP of this
 * component, so nothing reads a clock and there is no future-date rot to guard against. The window is
 * measured from that prop.
 *
 * Scope note: jsdom applies no CSS, so this catches rendering logic, not the amber.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { ReplacementLeavePanel, type ReplacementCreditRow } from '../components/leave/ReplacementLeavePanel';

const AS_OF = '2026-08-03';
const copy = messages.leave.breakdown.replacement;

const credit = (over: Partial<ReplacementCreditRow> & Pick<ReplacementCreditRow, 'id' | 'expiresOn'>): ReplacementCreditRow => ({
  workedDate: '2026-07-04',
  daysCredited: 1,
  daysTaken: 0,
  status: 'active',
  remaining: 1,
  requestedOn: '2026-07-05',
  approvedOn: '2026-07-06T02:00:00.000Z',
  otMinutes: 480,
  ...over,
});

function renderPanel(rows: ReplacementCreditRow[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReplacementLeavePanel
        leaveTypeName="Replacement Leave"
        visual={{ color: null, icon: null, code: 'REPLACEMENT' }}
        asOf={AS_OF}
        available={rows.reduce((s, r) => s + (r.status === 'active' ? r.remaining : 0), 0)}
        data={{ rows, pendingDays: 0, leaveUnit: 'day', explanations: {} }}
        open
        onOpenChange={() => {}}
      />
    </NextIntlClientProvider>,
  );
}

/** The table row for a credit, found by its expiry date (unique across every fixture below). */
const rowFor = (expiresOn: string) => screen.getByText(expiresOn).closest('tr')!;

/**
 * The summary row, found by its HINT rather than its label — the label and the per-row badge are the SAME
 * WORDS on purpose ("Expiring soon" reads correctly in both places), so the label alone matches several
 * nodes. The hint names one deadline and is therefore unique. This is the same technique the 00307068
 * panel test uses for the two-stage balance, and for the same reason.
 */
const summaryFor = (deadline: string) =>
  screen.getByText(`Use these days by ${deadline} or they will be lost`).closest('div')!;

describe('r279 — Expiring soon on the Replacement Leave card', () => {
  it('flags a spendable credit inside the window, and names the FIRST deadline in the summary', () => {
    renderPanel([
      credit({ id: 'soon', expiresOn: '2026-08-20' }), // 17 days out ⇒ inside the 30-day window
      credit({ id: 'sooner', expiresOn: '2026-08-10', workedDate: '2026-06-01' }), // 7 days out
    ]);

    // The summary line exists, carries the total still at risk, and names the EARLIEST expiry — not
    // whichever row happens to sort first in the table (which is by approval date, newest first).
    const summary = summaryFor('2026-08-10');
    expect(within(summary).getByText(copy.expiringSoonLabel)).toBeInTheDocument();
    // Two credits of 1.00 each still unspent.
    expect(within(summary).getByText('2.00')).toBeInTheDocument();

    // …and BOTH rows carry the badge, so the reader can see which lines the figure is about.
    expect(within(rowFor('2026-08-20')).getByText(copy.expiringSoonBadge)).toBeInTheDocument();
    expect(within(rowFor('2026-08-10')).getByText(copy.expiringSoonBadge)).toBeInTheDocument();
  });

  it('says nothing at all when no credit is close — the row is absent, not a zero', () => {
    // An always-present "0.00 expiring soon" line trains the reader to skip the row that matters.
    renderPanel([credit({ id: 'far', expiresOn: '2026-11-01' })]); // 90 days out
    expect(screen.queryByText(copy.expiringSoonLabel)).not.toBeInTheDocument();
  });

  it('does not flag a credit that has ALREADY expired — that is expired, not expiring', () => {
    renderPanel([credit({ id: 'past', expiresOn: '2026-07-20' })]); // 14 days BEFORE asOf
    expect(screen.queryByText(copy.expiringSoonLabel)).not.toBeInTheDocument();
    expect(within(rowFor('2026-07-20')).queryByText(copy.expiringSoonBadge)).not.toBeInTheDocument();
  });

  it('does not flag a credit with nothing left to lose — used, lapsed or paid out', () => {
    renderPanel([
      credit({ id: 'taken', expiresOn: '2026-08-11', status: 'taken', daysTaken: 1, remaining: 0 }),
      credit({ id: 'lapsed', expiresOn: '2026-08-12', status: 'lapsed', remaining: 1 }),
      credit({ id: 'paid', expiresOn: '2026-08-13', status: 'converted_to_pay', remaining: 1 }),
      // An ACTIVE row that happens to be fully consumed: remaining 0, so there is nothing at risk.
      credit({ id: 'spent', expiresOn: '2026-08-14', daysTaken: 1, remaining: 0 }),
    ]);
    expect(screen.queryByText(copy.expiringSoonLabel)).not.toBeInTheDocument();
    for (const d of ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']) {
      expect(within(rowFor(d)).queryByText(copy.expiringSoonBadge), `row ${d}`).not.toBeInTheDocument();
    }
    // The existing status badges are untouched — this round ADDS a signal, it does not replace one.
    expect(screen.getByText(copy.statusTaken)).toBeInTheDocument();
    expect(screen.getByText(copy.statusExpired)).toBeInTheDocument();
    expect(screen.getByText(copy.statusConverted)).toBeInTheDocument();
  });

  it('counts only the REMAINING part of a partly-used credit', () => {
    // Half a day already spent: the employee stands to lose 0.50, not 1.00. Printing the credited figure
    // here would be the "the table contradicts the balance" complaint this panel exists to answer.
    renderPanel([credit({ id: 'half', expiresOn: '2026-08-15', daysTaken: 0.5, remaining: 0.5 })]);
    expect(within(summaryFor('2026-08-15')).getByText('0.50')).toBeInTheDocument();
    expect(within(rowFor('2026-08-15')).getByText(copy.expiringSoonBadge)).toBeInTheDocument();
    // …and it still carries its existing "partly used" marker.
    expect(screen.getByText(copy.statusPartlyUsed)).toBeInTheDocument();
  });

  it('the boundary is inclusive at both ends of the 30-day window', () => {
    renderPanel([
      credit({ id: 'edge-in', expiresOn: '2026-09-02' }), // exactly 30 days from asOf
      credit({ id: 'edge-out', expiresOn: '2026-09-03' }), // 31 days — one day too far
      credit({ id: 'today', expiresOn: AS_OF }), // expires today: still spendable today
    ]);
    expect(within(rowFor('2026-09-02')).getByText(copy.expiringSoonBadge)).toBeInTheDocument();
    expect(within(rowFor(AS_OF)).getByText(copy.expiringSoonBadge)).toBeInTheDocument();
    expect(within(rowFor('2026-09-03')).queryByText(copy.expiringSoonBadge)).not.toBeInTheDocument();
  });
});
