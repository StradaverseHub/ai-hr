/**
 * WP-B2 — the Leaders screen. Authority itself (who may appoint, change an HOD, override) is pinned against
 * real RLS in test/onehr-leader-seats.test.ts; these tests pin what the screen draws from the capability
 * flags and that it sends the service exactly what the preview showed.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('../app/(app)/performance/leaders/actions', () => ({
  previewHodChangeAction: vi.fn(), applyHodChangeAction: vi.fn(), appointLeaderSeatAction: vi.fn(), endLeaderSeatAction: vi.fn(),
  createCalibrationGroupAction: vi.fn(), renameCalibrationGroupAction: vi.fn(), calibrationGroupMembersAction: vi.fn(),
  addCalibrationGroupMembersAction: vi.fn(), endCalibrationGroupMemberAction: vi.fn(), generateCalibrationScopesAction: vi.fn(),
}));

import { LeadersAdmin } from '../app/(app)/performance/leaders/leaders-admin';
import { GenerateCalibrationScopes } from '../app/(app)/performance/leaders/generate-scopes';
import type { HodPreviewView, LeadersData } from '../app/(app)/performance/leaders/model';
import { applyHodChangeAction, appointLeaderSeatAction, generateCalibrationScopesAction, previewHodChangeAction } from '../app/(app)/performance/leaders/actions';

const L = en.onehr.leaders;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const GROUP = id(900), UNIT_A = id(901), UNIT_B = id(902);
const person = (n: number, name: string, companyId: string, dept: string) => ({ employmentId: id(n), name, employeeCode: `E${n}`, companyId, departmentId: id(800 + dept.length), departmentName: dept });

function fixture(write: boolean): LeadersData {
  return {
    people: [person(1, 'Aida Hod', UNIT_A, 'Sales'), person(2, 'Ben Staff', UNIT_A, 'Sales'), person(3, 'Chen Staff', UNIT_A, 'Sales'), person(4, 'Dina Next', UNIT_B, 'Finance')],
    companies: [
      { id: GROUP, name: 'Group Holdings', parentCompanyId: null, isGroupNode: true, canWriteBuCeo: write, canWriteBgCeo: write },
      { id: UNIT_A, name: 'Unit Alpha', parentCompanyId: GROUP, isGroupNode: false, canWriteBuCeo: write, canWriteBgCeo: false },
      { id: UNIT_B, name: 'Unit Beta', parentCompanyId: GROUP, isGroupNode: false, canWriteBuCeo: write, canWriteBgCeo: false },
    ],
    hods: [{ subjectEmploymentId: id(2), hodEmploymentId: id(1), hodName: 'Aida Hod' }, { subjectEmploymentId: id(3), hodEmploymentId: id(1), hodName: 'Aida Hod' }],
    seats: [{ id: id(700), seatType: 'bu_ceo', companyId: UNIT_A, calibrationGroupId: null, holderEmploymentId: id(1), holderName: 'Aida Hod', holderEmployeeCode: 'E1' }],
    groups: [{ id: id(600), name: 'Senior leaders', members: 3, chief: null }],
    canWriteHod: write, canWriteGroupChief: write,
  };
}
const show = (data: LeadersData) => render(<NextIntlClientProvider locale="en" messages={en}><LeadersAdmin data={data} /></NextIntlClientProvider>);
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));
function pick(scope: HTMLElement, text: string, option: RegExp) {
  const box = within(scope).getByRole('combobox');
  fireEvent.change(box, { target: { value: text } });
  fireEvent.mouseDown(within(scope).getByRole('option', { name: option }));
}

const preview = (over: Partial<HodPreviewView> = {}): HodPreviewView => ({
  rows: [{ subjectEmploymentId: id(2), subjectName: 'Ben Staff', subjectEmployeeCode: 'E2', companyName: 'Unit Alpha', departmentName: 'Sales', currentHodName: 'Aida Hod', nextHodName: 'Dina Next' }],
  unchanged: 0, selfExcluded: 0, blockers: [], warnings: [], fingerprint: 'f'.repeat(64), ...over,
});

beforeEach(() => {
  vi.mocked(previewHodChangeAction).mockReset();
  vi.mocked(applyHodChangeAction).mockReset().mockResolvedValue({ ok: true, data: { changed: 1 } });
  vi.mocked(appointLeaderSeatAction).mockReset().mockResolvedValue({ ok: true, data: { unchanged: false } });
});
afterEach(cleanup);

describe('Leaders screen', () => {
  it('renders the three tabs with their tables, the company filter only on HOD and BU', () => {
    show(fixture(true));
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([L.tabs.hod, L.tabs.bu, L.tabs.bg]);
    expect(screen.getByRole('heading', { name: 'E1 · Aida Hod' })).toBeTruthy();
    expect(screen.getByText('2 people')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: L.byDepartment }));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent).slice(0, 4)).toEqual([L.colDepartment, L.colCompany, L.colPeople, L.colHod]);
    expect(within(table).getByRole('row', { name: /Sales Unit Alpha 3/ })).toBeTruthy();
    expect(screen.getByLabelText(L.companyFilter)).toBeTruthy();
    tab(L.tabs.bu);
    expect(within(screen.getByRole('table')).getByRole('row', { name: /Unit Alpha 3 E1 · Aida Hod/ })).toBeTruthy();
    expect(within(screen.getByRole('table')).getByRole('row', { name: new RegExp(`Unit Beta 1 ${L.vacant}`) })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(L.companyFilter), { target: { value: UNIT_B } });
    expect(within(screen.getByRole('table')).queryByText('Unit Alpha')).toBeNull();
    tab(L.tabs.bg);
    expect(screen.queryByLabelText(L.companyFilter)).toBeNull();
    expect(screen.getByRole('row', { name: new RegExp(`Group Holdings ${L.vacant}`) })).toBeTruthy();
    expect(screen.getByRole('row', { name: new RegExp(`Senior leaders 3 ${L.vacant}`) })).toBeTruthy();
  });

  it('shows a read-only viewer no write controls on any tab', () => {
    show(fixture(false));
    expect(screen.getByText(L.readOnly)).toBeTruthy();
    expect(screen.queryByRole('button', { name: L.manage })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: L.byDepartment }));
    expect(screen.queryByRole('button', { name: L.assign })).toBeNull();
    expect(screen.queryByRole('button', { name: L.change })).toBeNull();
    tab(L.tabs.bu);
    expect(screen.queryAllByRole('button').length).toBe(0);
    tab(L.tabs.bg);
    expect(screen.queryAllByRole('button').length).toBe(0);
    expect(screen.queryByLabelText(L.groupName)).toBeNull();
  });

  it('previews an HOD change: warnings need a tick each before Apply, and Apply sends the fingerprint', async () => {
    vi.mocked(previewHodChangeAction).mockResolvedValue({ ok: true, data: preview({ warnings: [{ code: 'old_hod_decision_dropped', employmentIds: [id(2)] }, { code: 'import_overwrites', employmentIds: [id(2)] }] }) });
    show(fixture(true));
    fireEvent.click(screen.getByRole('button', { name: L.manage }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'E3 · Chen Staff' }));
    pick(screen.getByText(L.newHod).parentElement!, 'Dina', /Dina Next/);
    fireEvent.click(screen.getByRole('button', { name: L.changeHodSelected }));
    expect(vi.mocked(previewHodChangeAction)).toHaveBeenCalledWith({ subjectEmploymentIds: [id(2)], hodEmploymentId: id(4) });
    const region = await screen.findByRole('region', { name: L.previewTitle });
    await within(region).findByRole('row', { name: /E2 · Ben Staff Unit Alpha Sales Aida Hod Dina Next/ });
    const apply = within(region).getByRole('button', { name: L.apply }) as HTMLButtonElement;
    expect(within(region).getByText(L.warnings.old_hod_decision_dropped, { exact: false })).toBeTruthy();
    expect(apply.disabled).toBe(true);
    const ticks = within(region).getAllByRole('checkbox', { name: L.readIt });
    fireEvent.click(ticks[0]);
    expect(apply.disabled).toBe(true);
    fireEvent.click(ticks[1]);
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    await waitFor(() => expect(vi.mocked(applyHodChangeAction)).toHaveBeenCalledWith({ subjectEmploymentIds: [id(2)], hodEmploymentId: id(4), fingerprint: 'f'.repeat(64), acknowledged: true, overrideReason: undefined }));
    expect(await screen.findByText('1 person updated.')).toBeTruthy();
  });

  it('lists blockers and keeps Apply disabled until an override reason is given', async () => {
    vi.mocked(previewHodChangeAction).mockResolvedValue({ ok: true, data: preview({ blockers: [{ code: 'bu_review_locked', employmentIds: [id(2), id(3)] }] }) });
    show(fixture(true));
    fireEvent.click(screen.getByRole('button', { name: L.manage }));
    fireEvent.click(screen.getByRole('button', { name: L.removeAsHod }));
    expect(vi.mocked(previewHodChangeAction)).toHaveBeenCalledWith({ subjectEmploymentIds: [id(2), id(3)], hodEmploymentId: null });
    const region = await screen.findByRole('region', { name: L.previewTitle });
    await within(region).findByText(L.blockersTitle);
    expect(within(region).getByText(L.blockers.bu_review_locked, { exact: false })).toBeTruthy();
    expect(within(region).getByText('(E2 · Ben Staff, E3 · Chen Staff)')).toBeTruthy();
    const apply = within(region).getByRole('button', { name: L.apply }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.change(within(region).getByLabelText(L.overrideReason), { target: { value: '   ' } });
    expect(apply.disabled).toBe(true);
    fireEvent.change(within(region).getByLabelText(L.overrideReason), { target: { value: 'Agreed with the unit CEO' } });
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    await waitFor(() => expect(vi.mocked(applyHodChangeAction)).toHaveBeenCalledWith(expect.objectContaining({ acknowledged: false, overrideReason: 'Agreed with the unit CEO', fingerprint: 'f'.repeat(64) })));
  });

  it('shows the service refusal from apply and does not report success', async () => {
    vi.mocked(previewHodChangeAction).mockResolvedValue({ ok: true, data: preview() });
    vi.mocked(applyHodChangeAction).mockResolvedValue({ error: 'This change was previewed against different data. Preview it again.' });
    show(fixture(true));
    fireEvent.click(screen.getByRole('button', { name: L.manage }));
    pick(screen.getByText(L.newHod).parentElement!, 'Dina', /Dina Next/);
    fireEvent.click(screen.getByRole('button', { name: L.changeHodSelected }));
    const region = await screen.findByRole('region', { name: L.previewTitle });
    await within(region).findByRole('row', { name: /Ben Staff/ });
    fireEvent.click(within(region).getByRole('button', { name: L.apply }));
    expect(await within(region).findByRole('alert')).toHaveProperty('textContent', 'This change was previewed against different data. Preview it again.');
    expect(screen.queryByText('1 person updated.')).toBeNull();
  });

  it('changes a BU CEO with the seat, company and picked holder', async () => {
    show(fixture(true));
    tab(L.tabs.bu);
    fireEvent.click(screen.getByRole('button', { name: 'Change for Unit Beta' }));
    expect(screen.getByText(L.vacant, { selector: 'p *, p' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: L.endSeat })).toBeNull();
    pick(screen.getByText(L.changeTo).parentElement!, 'E2', /Ben Staff/);
    fireEvent.click(screen.getByRole('button', { name: L.save }));
    await waitFor(() => expect(vi.mocked(appointLeaderSeatAction)).toHaveBeenCalledWith({ seatType: 'bu_ceo', companyId: UNIT_B, calibrationGroupId: null, holderEmploymentId: id(2) }));
    expect(await screen.findByText(L.seatSaved)).toBeTruthy();
  });

  it('generates calibration scopes for a cycle and shows the counts', async () => {
    vi.mocked(generateCalibrationScopesAction).mockResolvedValue({ ok: true, data: { created: 3, extended: 1, added: 2, skipped: 1, people: 14 } });
    render(<NextIntlClientProvider locale="en" messages={en}><GenerateCalibrationScopes cycleId={id(500)} /></NextIntlClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: L.generate.button }));
    expect(vi.mocked(generateCalibrationScopesAction)).toHaveBeenCalledWith(id(500));
    expect(await screen.findByText('3 created, 1 extended, 14 people placed, 1 skipped.')).toBeTruthy();
  });
});
