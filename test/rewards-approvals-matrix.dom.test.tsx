// @vitest-environment jsdom
/**
 * P1 approvals matrix: the Approvals board's Matrix view and its decision labels, rendered from board rows the
 * way the server page renders them. Fictional rows only; the board's server actions are mocked out.
 */
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '../messages/en.json';
import type { RewardBoardRow } from '../packs/rewards/service';
import { rewardNextSeat, rewardRouteProgress } from '../packs/rewards/calendar';
import type { RewardRole, RewardStage } from '../packs/rewards/model';

vi.mock('../app/(app)/rewards/approvals/actions', () => ({ boardDecideAction: vi.fn(), sendReadyAction: vi.fn() }));
const { RewardBoardMatrix, boardActionLabels, boardStepPhrase } = await import('../app/(app)/rewards/approvals/board-parts');

const wrap = (node: ReactNode) => <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Kuala_Lumpur">{node}</NextIntlClientProvider>;
afterEach(cleanup);
const ANNUAL: RewardRole[] = ['bu', 'bg', 'gr', 'ctro', 'ec'];
const t = createTranslator({ locale: 'en', messages: en, namespace: 'rewards' }) as unknown as Parameters<typeof boardActionLabels>[0];

/** A board row at `status` on `route`, as boardRow would project it; decisions newest first. */
function row(id: string, status: RewardStage, over: Partial<RewardBoardRow> = {}, route = ANNUAL, decisions: { action: string; fromStage: string; toStage: string; createdAt: Date }[] = []): RewardBoardRow {
  const seat = status === 'draft' ? route[0] : status === 'approved' ? 'payroll' : status as RewardRole;
  const waiting = over.waiting ?? false;
  const action = !waiting ? null : status === 'draft' ? 'submit' : status === 'approved' ? 'post' : 'approve';
  return {
    id, kind: 'annual', name: `Unit ${id}`, cycle: 'Fictional cycle', companyId: 'c1', company: 'Fictional Co One', status: status as RewardBoardRow['status'], revision: 3, returnedTo: null,
    seat, step: null, progress: rewardRouteProgress(status, route, decisions), nextSeat: rewardNextSeat(status, route), due: null, daysUntilDue: null, payrollDue: null,
    waiting, action, canReturn: waiting && action === 'approve', ready: waiting, people: 4,
    salary: { increaseCents: 120000, poolCents: 1000000, poolShareBp: 1200, overLimit: false }, bonus: null, exceptions: 0, blocking: 0, ...over,
  };
}

describe('Rewards approvals board: decision labels', () => {
  it('names one decision per seat: BG approves, Group Rewards sends to CTRO, CTRO to EC, EC approves for payroll', () => {
    const at = (status: RewardStage) => boardActionLabels(t, row(status, status, { waiting: true }));
    expect(at('draft')).toEqual({ full: 'Submit to BG CEO', short: 'Submit' });
    expect(at('bg')).toEqual({ full: 'Approve', short: 'Approve' });
    expect(at('gr')).toEqual({ full: 'Send to CTRO', short: 'Send to CTRO' });
    expect(at('ctro')).toEqual({ full: 'Send to Executive Chairman', short: 'Send to EC' });
    expect(at('ec')).toEqual({ full: 'Approve for payroll', short: 'Approve' });
    // An off-cycle route that ends at CTRO approves for payroll there.
    expect(boardActionLabels(t, row('o', 'ctro', { waiting: true, kind: 'adhoc' }, ['bg', 'gr', 'ctro']))).toEqual({ full: 'Approve for payroll', short: 'Approve' });
  });
  it('the header phrase pairs the decision with its return', () => {
    expect(boardStepPhrase(t, 'en', row('g', 'gr', { waiting: true }))).toBe('Send to CTRO or return to BG / BU');
    expect(boardStepPhrase(t, 'en', row('b', 'bg', { waiting: true }))).toBe('Approve or return to BU CEO');
    expect(boardStepPhrase(t, 'en', row('e', 'ec', { waiting: true }))).toBe('Approve for payroll or reject · back to BG / BU');
    expect(boardStepPhrase(t, 'en', row('d', 'draft', { waiting: true }))).toBe('Submit to BG CEO');
  });
});

describe('Rewards approvals board: Matrix view', () => {
  const submitted = new Date('2026-01-05T01:30:00Z'), approved = new Date('2026-01-06T02:00:00Z');
  const gr = row('gr', 'gr', { waiting: true, due: '2026-02-10', daysUntilDue: 3, payrollDue: '2026-03-25' }, ANNUAL,
    [{ action: 'approve', fromStage: 'bg', toStage: 'gr', createdAt: approved }, { action: 'submit', fromStage: 'draft', toStage: 'bg', createdAt: submitted }]);
  const late = row('late', 'ctro', { companyId: 'c2', company: 'Fictional Co Two', due: '2026-01-03', daysUntilDue: -2, payrollDue: '2026-03-25' });

  it('shows Done with the decision time, Your step with its due date, and an unreached step as ○', () => {
    render(wrap(<RewardBoardMatrix rows={[gr]} section="waiting" />));
    const table = screen.getByRole('table', { name: en.rewards.board.route.annual });
    const cells = within(table).getAllByRole('row').at(-1)!.querySelectorAll('td');
    const text = [...cells].map(c => c.textContent);
    // Unit, salary, bonus, flags, then the six steps, then the action.
    expect(text.length).toBe(4 + 6 + 1);
    // Unit: the unit name links, then people, then the cycle truncated with its full name in the title.
    expect(within(cells[0] as HTMLElement).getByRole('link').textContent).toBe('Unit gr');
    expect(text[0]).toBe('Unit gr4 peopleFictional cycle');
    expect(cells[0].querySelector('.truncate')!.getAttribute('title')).toBe('Fictional cycle');
    // Done: compact 24h Kuala Lumpur time on screen; the full date and time in the title and for screen readers.
    const time = (cell: Element) => cell.querySelector('[title]')!;
    expect(time(cells[4]).getAttribute('title')).toBe('Jan 5, 2026, 9:30 AM');
    expect(time(cells[4]).querySelector('[aria-hidden="true"]')!.textContent).toBe('Jan 5, 09:30');
    expect(time(cells[4]).querySelector('.sr-only')!.textContent).toBe('Jan 5, 2026, 9:30 AM');
    expect(text[4]).toMatch(/^Done/);
    expect(time(cells[5]).querySelector('[aria-hidden="true"]')!.textContent).toBe('Jan 6, 10:00');
    expect(text[6]).toBe('Your stepDue Feb 10');
    expect(text.slice(7, 10)).toEqual(['○Not reached', '○Not reached', '○Not reached']);
    expect(within(cells[10] as HTMLElement).getByRole('button', { name: 'Send to CTRO' })).toBeTruthy();
    expect(within(cells[10] as HTMLElement).getByRole('link', { name: 'Return to BG / BU' })).toBeTruthy();
    // Column headers: step number, seat and duty; payroll names the calendar's payroll date.
    const headers = within(table).getAllByRole('columnheader').map(h => h.textContent);
    expect(headers).toContain('3 Group RewardsCheck · send on');
    expect(headers).toContain('6 PayrollPay · Mar 25');
  });
  it('groups rows by company, reads With them / Overdue for others, Returned in warning, and splits off-cycle routes', () => {
    const returned = row('ret', 'draft', { returnedTo: 'bu', companyId: 'c2', company: 'Fictional Co Two' });
    const offcycle = row('off', 'gr', { kind: 'adhoc' }, ['bu', 'bg', 'gr']);
    render(wrap(<RewardBoardMatrix rows={[gr, late, returned, offcycle]} section="elsewhere" />));
    const annual = screen.getByRole('table', { name: en.rewards.board.route.annual });
    const groupHeaders = within(annual).getAllByRole('columnheader').filter(h => h.getAttribute('scope') === 'colgroup').map(h => h.textContent);
    expect(groupHeaders).toEqual(['Fictional Co One', 'Fictional Co Two']);
    expect(annual.textContent).toContain('With themOverdue Jan 3');
    expect(within(annual).getByText('Returned').className).toContain('amber');
    // Payroll dates differ across the table's reviews (one has none): the duty line stays "Pay".
    expect(within(annual).getAllByRole('columnheader').map(h => h.textContent)).toContain('6 PayrollPay');
    const off = screen.getByRole('table', { name: en.rewards.board.route.offcycle });
    expect(within(off).getAllByRole('columnheader').map(h => h.textContent)).toContain('4 PayrollPay');
    expect(within(off).queryByText('Fictional Co Two')).toBeNull();
  });
});
