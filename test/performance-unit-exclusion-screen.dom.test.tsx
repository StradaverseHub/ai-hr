/**
 * D-P1-22 X5 (ADR-0150, APR-024) — the "Units not taking part" card on the cycle page. The rule's authority, plan,
 * digest and revision checks are pinned against the real database in test/performance-unit-exclusion-*.test.ts;
 * these tests pin what the screen draws from the service's answers and what it sends back.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';

const ports = vi.hoisted(() => ({ preview: vi.fn(), save: vi.fn(), end: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/', useSearchParams: () => new URLSearchParams(), redirect: vi.fn(), useRouter: () => ({ refresh: ports.refresh, push: vi.fn() }) }));
vi.mock('../app/(app)/performance/unit-exclusion-actions', () => ({ previewUnitExclusionAction: ports.preview, saveUnitExclusionAction: ports.save, endUnitExclusionAction: ports.end }));

import { UnitExclusionCard } from '../app/(app)/performance/onehr/unit-exclusion-card';
import type { UnitExclusionPreviewView, UnitExclusionScreen } from '../packs/performance/service';

const t = en.onehr.unitExclusion;
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k]));

const CYCLE = '00000000-0000-4000-8000-000000000001';
const NORTH = '00000000-0000-4000-8000-0000000000a1';
const FINANCE = '00000000-0000-4000-8000-0000000000d1';
const SALES = '00000000-0000-4000-8000-0000000000d2';
const DIGEST = 'a'.repeat(64);

function screenData(over: Partial<UnitExclusionScreen> = {}): UnitExclusionScreen {
  return {
    cycle: { id: CYCLE, name: 'Annual 2026', status: 'open', revision: 7 },
    canWrite: true, editable: true,
    rules: [
      { id: 'rule-active', companyId: NORTH, companyName: 'Northwind Sdn Bhd', departmentId: FINANCE, departmentName: 'Finance', createdByName: 'Hana Lee', createdAt: '2026-10-20T02:00:00.000Z', endedByName: null, endedAt: null, endReason: null, active: true },
      { id: 'rule-ended', companyId: 'south', companyName: 'Southwind Bhd', departmentId: null, departmentName: null, createdByName: 'Hana Lee', createdAt: '2026-10-01T02:00:00.000Z', endedByName: 'Hana Lee', endedAt: '2026-10-05T02:00:00.000Z', endReason: 'brought_back', active: false },
    ],
    companies: [{ id: NORTH, name: 'Northwind Sdn Bhd', departments: [{ id: FINANCE, name: 'Finance', people: 1 }, { id: SALES, name: 'Sales', people: 12 }] }],
    ...over,
  };
}
const plan: UnitExclusionPreviewView = {
  companyId: NORTH, departmentId: SALES, digest: DIGEST, revision: 7, alreadyActive: false, subsumed: 0,
  counts: { people: 3, frozenPeople: 1, own: 5, places: 4, submitted: 9, frozenSkipped: 2, belowFullPanel: 2, moves: 2, oneLevelUp: 1, nobodyAbove: 1, hodOut: 1, seatsOut: 1, sessionReviewersOut: 0 },
  submittedPlaces: 1,
  oneLevelUp: [{ reviewId: 'r1', person: 'Ira Tan', from: 'Omar Diaz', to: 'Pia Wong' }],
  nobodyAbove: [{ reviewId: 'r2', person: 'Quin Yeo', reason: 'kpi' }],
  seatsByType: [{ seatType: 'bu_ceo', count: 1 }],
  hodSessionsOut: 0,
};

function page(data: UnitExclusionScreen = screenData()) {
  return render(<NextIntlClientProvider locale="en" messages={en}><UnitExclusionCard screen={data} /></NextIntlClientProvider>);
}
/** Real <button> elements only (a <summary> is not a write control). */
const buttons = () => [...document.querySelectorAll('button')];
async function previewSales() {
  ports.preview.mockResolvedValue({ ok: true, data: plan });
  fireEvent.change(screen.getByRole('combobox', { name: t.company }), { target: { value: NORTH } });
  fireEvent.click(screen.getByLabelText(t.departments, { selector: 'input[name="unit-exclusion-scope"]' }));
  // Chips carry the backend's people count (app.onehr_unit_exclusion_choices): picked, never typed.
  expect(screen.getAllByRole('radio').filter((r) => r.getAttribute('name') === 'unit-exclusion-department').map((r) => r.closest('label')?.textContent)).toEqual(['Finance · 1 person', 'Sales · 12 people']);
  fireEvent.click(screen.getByLabelText('Sales · 12 people'));
  fireEvent.click(screen.getByRole('button', { name: t.preview }));
  return screen.findByRole('region', { name: t.previewTitle });
}

beforeEach(() => { for (const fn of Object.values(ports)) fn.mockReset(); });
afterEach(cleanup);

describe('Units not taking part', () => {
  it('lists active rules, keeps ended rules as history, and Bring back confirms before calling the service', async () => {
    ports.end.mockResolvedValue({ ok: true, data: null });
    page();
    const rules = screen.getByRole('region', { name: t.rulesTitle });
    // The history table sits in a closed <details>: query it regardless of disclosure state.
    const [active, history] = within(rules).getAllByRole('table', { hidden: true });
    const row = within(active).getAllByRole('row')[1];
    expect(within(row).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Northwind Sdn Bhd', 'Finance', 'Hana Lee', '20-Oct-2026', t.bringBack]);
    expect(within(rules).getByText(fill(t.history, { count: 1 }))).toBeTruthy();
    expect(within(rules).getByText(t.historyHelp)).toBeTruthy();
    const ended = within(history).getAllByRole('row', { hidden: true })[1];
    expect(ended.textContent).toContain('Southwind Bhd');
    expect(ended.textContent).toContain(t.wholeCompany);
    expect(ended.textContent).toContain('05-Oct-2026');
    expect(ended.textContent).toContain(t.endReasons.brought_back);

    fireEvent.click(within(row).getByRole('button', { name: t.bringBack }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(fill(t.bringBackTitle, { scope: 'Finance (Northwind Sdn Bhd)', cycle: 'Annual 2026' }))).toBeTruthy();
    expect(within(dialog).getByText(t.bringBackBody)).toBeTruthy();
    expect(ports.end).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: t.bringBack }));
    await waitFor(() => expect(ports.end).toHaveBeenCalledWith({ cycleId: CYCLE, ruleId: 'rule-active', revision: 7 }));
    await waitFor(() => expect(ports.refresh).toHaveBeenCalled());
    expect(await screen.findByText(t.broughtBack)).toBeTruthy();
  });

  it('Back in the Bring back dialog changes nothing', async () => {
    page();
    fireEvent.click(screen.getByRole('button', { name: t.bringBack }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: t.back }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(ports.end).not.toHaveBeenCalled();
  });

  it('a read-only viewer sees the rules but no write control', () => {
    page(screenData({ canWrite: false, editable: false, companies: [] }));
    expect(screen.getByText('Northwind Sdn Bhd')).toBeTruthy();
    expect(buttons()).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: t.leaveOutTitle })).toBeNull();
  });

  it('a writer on a closed cycle sees no write control either', () => {
    page(screenData({ cycle: { id: CYCLE, name: 'Annual 2026', status: 'closed', revision: 7 }, editable: false, companies: [] }));
    expect(buttons()).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
  });

  it('shows an empty line when every unit takes part', () => {
    page(screenData({ rules: [] }));
    expect(screen.getByText(t.none)).toBeTruthy();
  });

  it('Preview asks for the chosen scope and renders the tiles, the Becomes table and the warnings', async () => {
    page();
    expect((screen.getByRole('button', { name: t.preview }) as HTMLButtonElement).disabled).toBe(true);
    const region = await previewSales();
    expect(ports.preview).toHaveBeenCalledWith({ cycleId: CYCLE, companyId: NORTH, departmentId: SALES });
    const tiles = region.querySelector('[data-stat-cells]')!;
    const cells = [...tiles.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    expect(cells).toEqual([
      [t.tiles.people, '3'],
      [t.tiles.places, `4${fill(t.tiles.placesDetail, { submitted: 1, below: 2 })}`],
      [t.tiles.own, '5'],
      [t.tiles.oneLevelUp, '1'],
    ]);
    const table = within(region).getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([t.person, t.reviewerNow, t.becomes]);
    expect(within(table).getAllByRole('row')[1].textContent).toBe('Ira TanOmar DiazPia Wong');
    expect(within(region).getByText(fill(t.kpiMoves, { count: 2 }))).toBeTruthy();
    const seats = within(region).getByText((_, el) => el?.tagName === 'LI' && !!el.textContent?.startsWith(fill(t.seats, { seats: 'BU CEO 1 · Head of department 1' })));
    expect(within(seats).getByRole('link', { name: t.leadersLink }).getAttribute('href')).toBe('/performance/leaders');
    expect(within(region).getByText(`Quin Yeo · ${t.nobodyReasons.kpi}`)).toBeTruthy();
    expect(within(region).getByText(fill(t.frozen, { people: 1, rows: 2 }))).toBeTruthy();
    expect(within(region).getByText(t.nothingDeleted)).toBeTruthy();
  });

  it('changing the selection discards the preview', async () => {
    page();
    await previewSales();
    fireEvent.click(screen.getByLabelText(t.wholeCompany));
    expect(screen.queryByRole('region', { name: t.previewTitle })).toBeNull();
  });

  it('Continue opens the confirmation with the counts; Back leaves without saving', async () => {
    page();
    const region = await previewSales();
    fireEvent.click(within(region).getByRole('button', { name: t.continue }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(fill(t.confirmTitle, { scope: 'Sales (Northwind Sdn Bhd)', cycle: 'Annual 2026' }))).toBeTruthy();
    expect(within(dialog).getByText(fill(t.confirmBody, { people: 3, places: 4, own: 5, moves: 2, oneLevelUp: 1 }))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: t.back }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(ports.save).not.toHaveBeenCalled();
  });

  it('Leave out sends the previewed scope with its digest and revision', async () => {
    ports.save.mockResolvedValue({ ok: true, data: { alreadyActive: false } });
    page();
    const region = await previewSales();
    fireEvent.click(within(region).getByRole('button', { name: t.continue }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: t.leaveOut }));
    await waitFor(() => expect(ports.save).toHaveBeenCalledWith({ cycleId: CYCLE, companyId: NORTH, departmentId: SALES, digest: DIGEST, revision: 7 }));
    expect(await screen.findByText(t.saved)).toBeTruthy();
    expect(ports.refresh).toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: t.previewTitle })).toBeNull();
  });

  it('a stale preview refusal is shown inline and the preview stays for a new one', async () => {
    const stale = 'The cycle changed since the preview. Preview the change again.';
    ports.save.mockResolvedValue({ error: stale });
    page();
    const region = await previewSales();
    fireEvent.click(within(region).getByRole('button', { name: t.continue }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: t.leaveOut }));
    expect(await within(region).findByText(stale)).toBeTruthy();
    expect(ports.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: t.preview })).toBeTruthy();
  });

  it('a preview refusal from the service is shown under the form', async () => {
    ports.preview.mockResolvedValue({ error: 'Nobody works in this unit today. Choose a unit with people in it.' });
    page();
    fireEvent.change(screen.getByRole('combobox', { name: t.company }), { target: { value: NORTH } });
    fireEvent.click(screen.getByRole('button', { name: t.preview }));
    expect(await screen.findByText('Nobody works in this unit today. Choose a unit with people in it.')).toBeTruthy();
    expect(ports.preview).toHaveBeenCalledWith({ cycleId: CYCLE, companyId: NORTH, departmentId: null });
  });
});
