/**
 * WP-E (CF-08) — the bulk release board and the "What you led" read, rendered in jsdom with the real
 * English messages. The server decides every person again (test/onehr-release-two-step.test.ts); these pin
 * what the screens count, offer and post.
 */
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../app/(app)/performance/onehr-actions', () => ({ bulkReleaseAction: vi.fn() }));
import { ReleaseBoard } from '../app/(app)/performance/onehr/release-board';
import { LedPeople } from '../app/(app)/performance/onehr/led-people';
import { bulkReleaseAction } from '../app/(app)/performance/onehr-actions';
import type { ReleaseBoardRow } from '../packs/performance/service';

const T = en.onehr.resultRelease, L = en.onehr.led;
const at = '2026-10-20T02:00:00.000Z';
const cell = (band: string, over: Partial<{ final: boolean; leaderAt: string | null; employeeAt: string | null }> = {}) => ({ band, final: true, stage: 'final', leaderAt: null, employeeAt: null, ...over });
function row(id: string, name: string, over: Partial<ReleaseBoardRow> = {}): ReleaseBoardRow {
  const performance = over.performance === undefined ? cell('ME') : over.performance, potential = over.potential === undefined ? cell('Mid') : over.potential, talent = over.talent === undefined ? cell('Solid Core') : over.talent;
  const cells = [performance, potential, talent].filter((c): c is NonNullable<typeof c> => !!c);
  return {
    reviewId: id, employmentId: `e-${id}`, name, employeeCode: `C${id}`, department: 'Sales', grade: '12', companyId: 'co', company: 'Unit', businessGroup: 'Group',
    performance, potential, talent, report: { final: true, employeeAt: null },
    leaders: { lm: ['Lina Manager'], hod: ['Hadi Head'], bu: [] },
    state: { ready: cells.some((c) => c.final && !c.leaderAt), leadOpen: cells.some((c) => !c.leaderAt), withLeaders: cells.some((c) => c.leaderAt && !c.employeeAt), toEmp: cells.length > 0 && cells.every((c) => c.employeeAt), leadAll: cells.length > 0 && cells.every((c) => c.leaderAt), notFinal: cells.some((c) => !c.final) },
    ...over,
  };
}
const ready = row('r1', 'Ready Person');
const withLeaders = row('r2', 'Leader Held', { performance: cell('AE', { leaderAt: at }), potential: cell('High', { leaderAt: at }), talent: cell('Star', { leaderAt: at }) });
const open = row('r3', 'Open Person', { performance: cell('BE', { final: false }) });
function show(rows = [ready, withLeaders, open], email: 'on' | 'off' = 'on') {
  render(<NextIntlClientProvider locale="en" messages={en}><ReleaseBoard cycleId="cycle-1" cycleName="Annual" potential midYear={false} email={email} filters={{ businessGroup: 'Group', companyId: '', department: '', status: '' }} rows={rows}/></NextIntlClientProvider>);
}
const button = (name: string | RegExp) => within(screen.getByRole('toolbar', { name: T.stepsLabel })).getByRole('button', { name });
beforeEach(() => vi.mocked(bulkReleaseAction).mockReset().mockResolvedValue(undefined as never));
afterEach(cleanup);

it('disables every step until someone is picked, then counts who each step would reach', () => {
  show();
  expect(screen.getByText(T.noneSelected)).toBeTruthy();
  expect((button(T.toLeaders) as HTMLButtonElement).disabled).toBe(true);
  expect((button(T.toEmployees) as HTMLButtonElement).disabled).toBe(true);
  expect((button(new RegExp(`^${T.revoke}`)) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: T.selectAll }));
  expect(screen.getByText('3 selected')).toBeTruthy();
  expect((button('Release to leaders (2)') as HTMLButtonElement).disabled).toBe(false);
  expect((button('Release to employees (1)') as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText('2 of them are not with their leaders yet')).toBeTruthy();
  const rows = screen.getAllByRole('row');
  expect(within(rows[1]).getByText(T.l1.notReleased)).toBeTruthy();
  expect(within(rows[2]).getByText('Released 2026-10-20')).toBeTruthy();
  expect(within(rows[2]).getByText(T.l2.waiting)).toBeTruthy();
  expect(within(rows[3]).getByText(T.l1.notFinal)).toBeTruthy();
});

it('names the leaders in step 1 and posts only the people with something to send', async () => {
  show();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ready Person' }));
  fireEvent.click(button('Release to leaders (1)'));
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText(T.dialog.step1Kicker)).toBeTruthy();
  expect(within(dialog).getByText("Release 1 person's results to their leaders?")).toBeTruthy();
  expect(within(dialog).getByText('Lina Manager')).toBeTruthy();
  expect(within(dialog).getByText('Hadi Head')).toBeTruthy();
  expect(within(dialog).getByText(T.dialog.nobody)).toBeTruthy();
  expect(within(dialog).getByText(T.dialog.noticesLeaders)).toBeTruthy();
  expect(within(dialog).getByText(T.dialog.emailOn)).toBeTruthy();
  expect(within(dialog).queryAllByText(/\b(ME|Mid|Solid Core)\b/)).toEqual([]);
  fireEvent.click(within(dialog).getByRole('button', { name: T.toLeaders }));
  await waitFor(() => expect(bulkReleaseAction).toHaveBeenCalledOnce());
  const f = vi.mocked(bulkReleaseAction).mock.calls[0][0] as FormData;
  expect(Object.fromEntries(['cycleId', 'result', 'to', 'action', 'businessGroup'].map((k) => [k, f.get(k)]))).toEqual({ cycleId: 'cycle-1', result: 'three', to: 'leaders', action: 'release', businessGroup: 'Group' });
  expect(f.getAll('ids')).toEqual(['r1']);
});

it('step 2 lists who is not with their leaders yet and cannot send when nobody is ready', async () => {
  show([ready, open], 'off');
  fireEvent.click(screen.getByRole('checkbox', { name: T.selectAll }));
  fireEvent.click(button(T.toEmployees));
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('Left out: 2 people are not with their leaders yet')).toBeTruthy();
  expect(within(dialog).getAllByRole('button', { name: T.dialog.goTo })).toHaveLength(2);
  expect((within(dialog).getByRole('button', { name: 'Release to 0 people' }) as HTMLButtonElement).disabled).toBe(true);
  expect(bulkReleaseAction).not.toHaveBeenCalled();
});

it('offers exactly two revoke choices and posts the one picked for everyone selected', async () => {
  show();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Leader Held' }));
  const revoke = button(new RegExp(`^${T.revoke}`));
  fireEvent.click(revoke);
  expect(revoke.getAttribute('aria-expanded')).toBe('true');
  const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
  expect(items.map((i) => i.textContent)).toEqual([T.revokeEmployees, T.revokeBoth]);
  fireEvent.click(items[1]);
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText(T.dialog.revokeBothBody)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: T.dialog.revokeConfirm }));
  await waitFor(() => expect(bulkReleaseAction).toHaveBeenCalledOnce());
  const f = vi.mocked(bulkReleaseAction).mock.calls[0][0] as FormData;
  expect([f.get('to'), f.get('action'), f.getAll('ids')]).toEqual(['both', 'revoke', ['r2']]);
});

it('never offers release 1 for the 360 report', () => {
  show();
  fireEvent.click(screen.getByRole('checkbox', { name: T.selectAll }));
  fireEvent.change(screen.getByRole('combobox', { name: T.results }), { target: { value: 'feedback' } });
  expect((button(T.toLeaders) as HTMLButtonElement).disabled).toBe(true);
  expect((button('Release to employees (3)') as HTMLButtonElement).disabled).toBe(false);
});

// ── What you led ────────────────────────────────────────────────────────────────────────────────────────
const step = (tier: string, band: string | null, state: string, why = '', dir: 'up' | 'down' | null = null) => ({ tier, band, state, why, dir, you: tier === 'bu' });
const beforePerson = {
  reviewId: 'p1', name: 'Aina Before', employeeCode: 'A1', department: 'Sales', grade: '12', company: 'Unit', role: 'bu' as const, midYear: false,
  summary: { performance: 'AE', potential: 'High', talent: null as string | null, full: false, moves: 2, you: ['potential'] as ('performance' | 'potential')[], none: false },
  release: { key: 'inCalibration' as 'inCalibration' | 'withYouSince', at: null as string | null, tone: 'none' as 'none' | 'you' },
  axes: [
    { axis: 'performance' as const, final: null as string | null, full: false, hasResult: true, steps: [step('self', 'BE', 'set'), step('lm', 'ME', 'moved', '', 'up'), step('hod', 'AE', 'moved', 'Wider impact', 'up'), step('bu', 'AE', 'kept', 'Agreed'), step('bg', null, 'hidden')] },
    { axis: 'potential' as const, final: null as string | null, full: false, hasResult: true, steps: [step('self', null, 'none'), step('lm', 'Mid', 'set'), step('hod', 'Mid', 'kept'), step('bu', 'High', 'moved', 'Leads others', 'up'), step('bg', null, 'hidden')] },
  ],
};
const afterPerson = { ...beforePerson, reviewId: 'p2', name: 'Bala After', summary: { performance: 'OU', potential: 'High', talent: 'Super Star', full: true, moves: 3, you: [], none: false }, release: { key: 'withYouSince' as const, at, tone: 'you' as const },
  axes: beforePerson.axes.map((x) => ({ ...x, full: true, final: x.axis === 'performance' ? 'OU' : 'High', steps: x.steps.map((s) => (s.tier === 'bg' ? step('bg', x.axis === 'performance' ? 'OU' : 'High', x.axis === 'performance' ? 'moved' : 'kept', 'Group decision', 'up') : s)) })) };
function led(people: typeof beforePerson[], state: 'before' | 'mixed' | 'after') {
  const data = { cycles: [{ id: 'c1', name: 'Annual', periodEnd: '2026-12-31', status: 'open', people: people.length }], cycle: { id: 'c1', name: 'Annual', periodEnd: '2026-12-31', status: 'open', people: people.length },
    tabs: [{ key: 'bu' as const, n: people.length }], tab: 'bu' as const, filter: null, people, nRes: people.length, nFull: people.filter((p) => p.summary.full).length, state, atOnce: false, midYear: false };
  render(<NextIntlClientProvider locale="en" messages={en}><LedPeople data={data as never}/></NextIntlClientProvider>);
}

it('What you led: before step 1 a row shows the bands up to the leader’s step and hides the rest with no reason', () => {
  led([beforePerson], 'before');
  expect(screen.getByText(L.subBefore)).toBeTruthy();
  expect(screen.getByText(L.noteBefore)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Business unit · 1' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getAllByText(L.release.inCalibration).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText('You moved potential')).toBeTruthy();
  const toggle = screen.getByRole('button', { name: "Show how Aina Before's bands moved" });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  const chain = document.getElementById('led-chain-p1')!;
  expect(within(chain).getAllByText(L.hidden).length).toBeGreaterThanOrEqual(2);
  expect(within(chain).getAllByText('BU CEO · you').length).toBeGreaterThanOrEqual(1);
  expect(within(chain).getByText('“Wider impact”')).toBeTruthy();
  expect(within(chain).getByText(L.afterYours)).toBeTruthy();
  expect(chain.textContent).not.toContain('Group decision');
});

it('What you led: after step 1 the final bands, talent status and every tier’s reason show; filters narrow the list', () => {
  led([beforePerson, afterPerson], 'mixed');
  expect(screen.getByText('1 of 2 released to you. Open a person to see how both bands moved.')).toBeTruthy();
  expect(screen.getAllByText('Super Star').length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText(`With you since 2026-10-20`)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: "Show how Bala After's bands moved" }));
  const chain = document.getElementById('led-chain-p2')!;
  expect(within(chain).getAllByText('“Group decision”')).toHaveLength(2);
  expect(within(chain).queryByText(L.afterYours)).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: L.movedOnly }));
  expect(screen.getByText('2 of 2 shown')).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: L.finalBand }), { target: { value: 'OU' } });
  expect(screen.getByText('1 of 2 shown')).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox', { name: L.search }), { target: { value: 'nobody here' } });
  expect(screen.getByText(L.noMatch)).toBeTruthy();
});

it('What you led: a viewer who leads nobody sees an empty page, not a refusal', () => {
  render(<NextIntlClientProvider locale="en" messages={en}><LedPeople data={{ cycles: [], cycle: null, tabs: [], tab: null, state: 'before', atOnce: false, nFull: 0, nRes: 0, midYear: false, filter: null, people: [] } as never}/></NextIntlClientProvider>);
  expect(screen.getByText(L.none)).toBeTruthy();
});
