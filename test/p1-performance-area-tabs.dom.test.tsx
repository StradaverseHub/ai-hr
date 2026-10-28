/**
 * D-P1-32 PT-X1: the one tab strip draws exactly the gated tabs of its strip, with the approved labels, lights
 * the current tab (including the "stays lit" paths), shows a locked Career Plan tab as a disabled non-link, and
 * scrolls sideways inside itself at 390px. Colours come from theme tokens only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
const location = vi.hoisted(() => ({ path: '/performance', search: '' }));
vi.mock('next/navigation', () => ({ usePathname: () => location.path, useSearchParams: () => new URLSearchParams(location.search) }));
import { PerformanceTabStrip } from '../components/performance-tabs';
import {
  performanceAreaStrip,
  performanceAreaStrips,
  PERFORMANCE_AREA_TABS,
  PERFORMANCE_STRIP_LABEL_KEYS,
  type PerformanceAreaFacts,
  type PerformanceAreaItem,
  type PerformanceAreaStrip,
} from '../packs/performance/onehr/tab-model';

afterEach(() => { cleanup(); location.path = '/performance'; location.search = ''; });

const label = (key: string) => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages.performanceArea) as string;
const item = (view: PerformanceAreaItem['view'], module: PerformanceAreaItem['module'], stage: string, extra: Partial<PerformanceAreaItem> = {}): PerformanceAreaItem =>
  ({ kind: 'review', cycleId: 'cycle-1', view, module, stage, locked: false, ...extra });
/** A viewer who holds every kind of work, so every tab of every strip passes its gate. */
const everything: PerformanceAreaFacts = {
  performanceOn: true,
  ownFeedbackReport: true,
  items: [
    item('mine', 'pm', 'setting'), item('mine', 'pm', 'results'), item('team', 'pm', 'setting'), item('team', 'pm', 'moderation'),
    { ...item('mine', 'tm', 'feedback'), kind: 'feedback' }, item('mine', 'tm', 'competency'), item('team', 'tm', 'competency'),
    item('mine', 'idp', 'career'), item('team', 'idp', 'career'),
    { ...item('bu', 'cal', 'calibration'), kind: 'calibration', axis: 'performance' }, { ...item('bu', 'cal', 'potential_calibration'), kind: 'calibration', axis: 'potential' },
    { ...item('bu', 'cal', 'talent_box'), kind: 'calibration', axis: 'both' },
  ],
};
function draw(strip: PerformanceAreaStrip, facts: PerformanceAreaFacts) {
  return render(<NextIntlClientProvider locale="en" messages={messages} onError={error => { throw error; }}>
    <PerformanceTabStrip strip={strip} facts={facts} />
  </NextIntlClientProvider>);
}
const nav = (strip: PerformanceAreaStrip) => screen.getByRole('navigation', { name: label(PERFORMANCE_STRIP_LABEL_KEYS[strip]) });

describe('every registry tab is drawn by the strip with its label', () => {
  it.each(performanceAreaStrips)('%s strip', strip => {
    draw(strip, everything);
    const own = PERFORMANCE_AREA_TABS.filter(entry => entry.strip === strip);
    expect(own.length).toBeGreaterThan(0);
    const links = within(nav(strip)).getAllByRole('link');
    expect(links.map(link => [link.textContent, link.getAttribute('href')])).toEqual(own.map(entry => [label(entry.labelKey), entry.href]));
  });
});

describe('a tab is drawn exactly when its gate passes', () => {
  const hod: PerformanceAreaFacts = { performanceOn: true, ownFeedbackReport: false, items: [
    item('mine', 'pm', 'results'), item('team', 'pm', 'results'),
    { ...item('dept', 'cal', 'department_review'), kind: 'calibration', axis: 'performance' },
    { ...item('dept', 'cal', 'talent_box'), kind: 'calibration', axis: 'both' },
  ] };
  it('an HOD sees Performance only in Calibration, never Talent box, and no Feedback tab', () => {
    draw('calibration', hod);
    expect(within(nav('calibration')).getAllByRole('link').map(link => link.textContent)).toEqual([messages.performanceArea.tabs.cal.performance]);
    expect(screen.queryByText(messages.performanceArea.tabs.cal.talentBox)).toBeNull();
    cleanup();
    draw('feedback', hod);
    expect(screen.queryByRole('navigation')).toBeNull();
  });
  it.each(performanceAreaStrips)('the %s strip draws the same tabs as the registry says, for every persona', strip => {
    for (const facts of [everything, hod, { ...everything, performanceOn: false }, { performanceOn: true, items: [], ownFeedbackReport: false }]) {
      const { unmount } = draw(strip, facts);
      const expected = performanceAreaStrip(facts, strip).map(view => label(PERFORMANCE_AREA_TABS.find(entry => entry.id === view.id)!.labelKey));
      const drawn = screen.queryByRole('navigation') ? within(nav(strip)).getAllByRole('listitem').map(li => li.textContent) : [];
      expect(drawn).toEqual(expected);
      unmount();
    }
  });
  it('draws nothing when the module is off', () => {
    const { container } = draw('home', { ...everything, performanceOn: false });
    expect(container.innerHTML).toBe('');
  });
});

describe('a locked own plan', () => {
  it('draws My plan and Career profile as disabled, non-link rows', () => {
    draw('plan', { performanceOn: true, ownFeedbackReport: false, items: [item('mine', 'idp', 'career', { locked: true }), item('team', 'idp', 'career')] });
    for (const word of [messages.performanceArea.tabs.idp.my, messages.performanceArea.tabs.idp.career]) {
      const row = screen.getByText(word).closest('[aria-disabled="true"]');
      expect(row, word).not.toBeNull();
      expect(row!.tagName).not.toBe('A');
      expect(row!.getAttribute('title')).toBe(messages.onehr.workspace.planLocked);
    }
    expect(document.querySelector('a[href="/performance/plan"]')).toBeNull();
    expect(document.querySelector('a[href="/performance/plan/profile"]')).toBeNull();
    expect(screen.getByRole('link', { name: messages.performanceArea.tabs.idp.team })).toHaveAttribute('href', '/performance/plan/team');
  });
});

describe('active tab', () => {
  const lit = () => Array.from(document.querySelectorAll('[aria-current="page"]')).map(node => node.textContent);
  it.each([
    ['pm', '/performance/team/8b0f8f3e-0d5e-4e57-9d62-5a0f3c1d2b11', '', messages.performanceArea.tabs.pm.team],
    ['pm', '/performance/team/kpis', '', messages.performanceArea.tabs.pm.approve],
    ['pm', '/performance/my', '', messages.performanceArea.tabs.pm.my],
    ['calibration', '/performance/calibration', 'axis=potential', messages.performanceArea.tabs.cal.potential],
    ['calibration', '/performance/calibration/talent-box/s1', '', messages.performanceArea.tabs.cal.talentBox],
  ] as const)('%s strip at %s?%s lights only %s', (strip, path, search, word) => {
    location.path = path; location.search = search;
    draw(strip, everything);
    expect(lit()).toEqual([word]);
  });
  it('lights nothing off the strip\'s routes', () => {
    location.path = '/performance/workspace';
    draw('pm', everything);
    expect(lit()).toEqual([]);
  });
});

describe('390px and theming', () => {
  it('scrolls sideways inside the strip instead of wrapping or widening the page', () => {
    draw('pm', everything);
    const strip = nav('pm');
    expect(strip.className).toMatch(/\boverflow-x-auto\b/);
    expect(strip.className).toMatch(/\bmax-w-full\b/);
    const list = within(strip).getByRole('list');
    expect(list.className).toMatch(/\bflex-nowrap\b/);
    expect(list.className).toMatch(/\bw-max\b/);
    for (const link of within(strip).getAllByRole('link')) expect(link.className).toMatch(/\bwhitespace-nowrap\b/);
  });
  it('uses theme tokens only (no literal colours in the markup)', () => {
    draw('plan', { ...everything, items: [item('mine', 'idp', 'career', { locked: true }), item('team', 'idp', 'career')] });
    draw('pm', everything);
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|style=/i);
    expect(html).toMatch(/\bbg-secondary\b/);
  });
});
