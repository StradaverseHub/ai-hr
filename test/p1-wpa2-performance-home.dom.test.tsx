/**
 * WP-A2 — the Performance block's markup, per theme. The three themes differ by CSS alone (Card, Status and
 * Button carry `monolith:`/`atelier:` utilities under <html data-ui-theme>), so each theme must render the
 * SAME words in the SAME order; every Home branch must mount the block (pinned against app/(app)/page.tsx).
 * Real ICU messages from messages/en.json through next-intl's own translator.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import en from '../messages/en.json';
import type { PerformanceHomeBlock } from '../packs/performance/onehr/home-cards';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: en, namespace: namespace as never }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));
const load = vi.fn<() => Promise<PerformanceHomeBlock | null>>();
// PT-X3: without a block the slot asks whether any performance work is assigned; here none is.
vi.mock('@/packs/performance/service', () => ({ getPerformanceHomeBlock: () => load(), hasAssignedPerformanceWork: async () => false }));
import { PerformanceHomeSlot, PerformanceHomeView } from '../components/performance-home/performance-home';

afterEach(() => { cleanup(); delete document.documentElement.dataset.uiTheme; load.mockReset(); });

const manager: PerformanceHomeBlock = {
  cycle: { id: 'c1', name: 'Fictional year-end', closesOn: '2026-12-31' },
  steps: [
    { key: 'kpi', state: 'done' }, { key: 'feedback360', state: 'done' }, { key: 'competency', state: 'yourTurn' },
    { key: 'careerPlan', state: 'locked' }, { key: 'teamReview', state: 'waiting', count: 12 }, { key: 'calibration', state: 'inProgress' },
    { key: 'results', state: 'released' },
  ],
  done: 3, total: 7,
  next: { kind: 'competency', done: 0, total: 10, dueOn: '2026-12-31', href: '/performance/workspace?cycle=c1&view=mine&module=tm' },
  team: { total: 12, chips: [{ kind: 'performanceReview', count: 2 }, { kind: 'assessmentWork', count: 1 }, { kind: 'careerPlan', count: 9 }], href: '/performance/workspace?cycle=c1&view=team' },
  standing: { performance: { state: 'awaitingManager' }, competency: 'notSubmitted', feedback360: 'released', careerTarget: { state: 'notSet' } },
  detailsHref: '/me/performance',
};
const H = en.performanceHome;
// The locale's own date form (the block formats through next-intl), never a hardcoded spelling.
const DAY = createFormatter({ locale: 'en', timeZone: 'UTC' }).dateTime(new Date('2026-12-31T00:00:00Z'), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const words = () => [...document.querySelectorAll('[data-step]')].map((li) => li.textContent);

describe.each(['classic', 'monolith', 'atelier'])('the Performance block under the %s theme', (theme) => {
  it('draws the strip, the next step, the team row and where you stand, in that order', async () => {
    if (theme !== 'classic') document.documentElement.dataset.uiTheme = theme;
    render(await PerformanceHomeView({ block: manager }));
    expect(screen.getByText('Fictional year-end')).toBeTruthy();
    expect(screen.getByText(`Closes ${DAY}`)).toBeTruthy();
    expect(screen.getByText('3 of 7 done')).toBeTruthy();
    expect(words()).toEqual([
      'KPI Check-inDone', '360 FeedbackDone', 'CompetencyYour turn', 'Career PlanLocked', 'Team review12 waiting', 'CalibrationIn progress', 'Results releasedReleased',
    ]);
    expect(document.querySelector('[data-step="competency"]')?.getAttribute('aria-current')).toBe('step');
    const next = document.querySelector('[data-performance-next]') as HTMLElement;
    expect(within(next).getByRole('heading', { name: H.next.competencyTitle })).toBeTruthy();
    expect(within(next).getByText(`0 of 10 answered · Due ${DAY}`)).toBeTruthy();
    expect(within(next).getByRole('link', { name: H.next.open }).getAttribute('href')).toBe('/performance/workspace?cycle=c1&view=mine&module=tm');
    expect(next.querySelector('[data-performance-team] p')?.textContent).toBe('Your team · 12 reviews waiting on you');
    expect([...next.querySelectorAll('[data-chip]')].map((c) => c.textContent)).toEqual(['Performance review 2', 'Performance assessment 1', 'Career plan review 9']);
    expect(within(next).getByRole('link', { name: H.team.open }).getAttribute('href')).toBe('/performance/workspace?cycle=c1&view=team');
    const standing = document.querySelector('[data-performance-standing]') as HTMLElement;
    expect([...standing.querySelectorAll('[data-standing]')].map((r) => r.textContent)).toEqual([
      'PerformanceAwaiting your manager', 'CompetencyNot submitted yet', '360 feedbackReport released', 'Career targetNot set yet',
    ]);
    // The block precedes its cards in reading order: strip, next step, standing.
    const order = ['[data-performance-strip]', '[data-performance-next]', '[data-performance-standing]'].map((q) => document.querySelector(q)!);
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('released results only, in the DOM', () => {
  const employee = (performance: PerformanceHomeBlock['standing']['performance']): PerformanceHomeBlock => ({
    ...manager, team: null, steps: [{ key: 'kpi', state: 'done' }, { key: 'results', state: performance?.state === 'released' ? 'released' : 'locked' }],
    next: { kind: 'none', nextDate: { kind: 'closes', on: '2026-12-31' } },
    standing: { performance, competency: null, feedback360: 'notReleased', careerTarget: { state: 'set', title: 'Senior engineer' } },
  });
  it('before release the row is a word and no band code is on the page; after release the band shows', async () => {
    const { unmount } = render(await PerformanceHomeView({ block: employee({ state: 'notReleased' }) }));
    const text = document.body.textContent ?? '';
    expect(text).toContain('PerformanceNot released yet');
    for (const band of ['UA', 'BE', 'ME', 'AE', 'OU']) expect(text).not.toMatch(new RegExp(`\\b${band}\\b`));
    expect(screen.getByText(H.next.none)).toBeTruthy();
    expect(screen.getByText(`This cycle closes ${DAY}`)).toBeTruthy();
    expect(screen.queryByRole('link', { name: H.next.open })).toBeNull();
    expect(document.querySelector('[data-performance-team]')).toBeNull();
    unmount();
    render(await PerformanceHomeView({ block: employee({ state: 'released', band: 'ME' }) }));
    expect(document.querySelector('[data-standing="performance"]')?.textContent).toBe('PerformanceME');
    expect(document.querySelector('[data-step="results"]')?.textContent).toBe('Results releasedReleased');
  });
});

describe('the slot', () => {
  it('renders nothing without a block, and nothing (not a calm state) when the read fails', async () => {
    load.mockResolvedValueOnce(null);
    expect(await PerformanceHomeSlot({ session: {} as never, scopeIds: undefined })).toBeNull();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    load.mockRejectedValueOnce(new Error('unavailable'));
    expect(await PerformanceHomeSlot({ session: {} as never, scopeIds: undefined })).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('calls no client-module function from the server (buttonVariants lives in a "use client" file)', () => {
    // Found by the render check: jsdom renders it, the RSC server refuses it, and Home silently loses the block.
    const src = fs.readFileSync(path.resolve(__dirname, '../components/performance-home/performance-home.tsx'), 'utf8');
    expect(src.length).toBeGreaterThan(2000);
    expect(src).not.toMatch(/buttonVariants\s*\(/);
    expect(fs.readFileSync(path.resolve(__dirname, '../components/ui/button.tsx'), 'utf8').startsWith("'use client'")).toBe(true);
  });

  it('every Home branch mounts the block: personal landing, Atelier, Monolith, Classic', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../app/(app)/page.tsx'), 'utf8');
    expect(page).toContain('const performanceBlock = <PerformanceHomeSlot session={s} scopeIds={scopeIds} />;');
    expect(page.match(/lead=\{performanceBlock\}/g)).toHaveLength(1);
    expect(page.match(/performance=\{performanceBlock\}/g)).toHaveLength(1);
    expect(page.match(/\{performanceBlock\}\n\s*<DashboardCustomizer/g)).toHaveLength(2);
    const atelier = fs.readFileSync(path.resolve(__dirname, '../app/dashboard-atelier.tsx'), 'utf8');
    expect(atelier.indexOf('{performance}')).toBeGreaterThan(0);
    expect(atelier.indexOf('{performance}')).toBeLessThan(atelier.indexOf('atelier-needs-you'));
    const surface = fs.readFileSync(path.resolve(__dirname, '../components/employee-home/home-surface.tsx'), 'utf8');
    expect(surface.indexOf('{lead}')).toBeGreaterThan(surface.indexOf('<PageHeader'));
    expect(surface.indexOf('{lead}')).toBeLessThan(surface.indexOf('visible.map('));
  });
});
