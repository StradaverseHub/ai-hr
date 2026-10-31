/**
 * D-P1-32 PT-X3 — the Performance & Talent home (/performance/home) in the DOM, per persona: card order and
 * conditions, at most one solid button (exactly one when something needs the viewer), Where you stand never shows
 * an unreleased band (an employee and a leader), the DQ-1 row, the leader card per seat, Your tools lists only the
 * tabs the viewer holds, the columns stack below `lg`, and the AI-HR home's "Your review" card in three themes.
 * Views are composed by the real pure model (homeNext, homeSlot, toolDoors, performanceHomeLayout); real ICU
 * messages from messages/en.json.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider, createFormatter, createTranslator } from 'next-intl';
import en from '../messages/en.json';
import type { PerformanceHomeBlock, HomeStanding } from '../packs/performance/onehr/home-cards';
import type { LeaderStatus } from '../packs/performance/onehr/leader-status-service';
import { homeNext, homeSlot, toolDoors, type HomeWorkItem, type NotInReason, type PerformanceHomeView as AreaHomeView, type RunningLeaderStatus } from '../packs/performance/onehr/performance-home-model';
import type { PerformanceAreaFacts } from '../packs/performance/onehr/tab-model';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: en, namespace: namespace as never }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/performance/home', useSearchParams: () => new URLSearchParams() }));
// The record AI read is the existing client component (cache read on open, generation only on request); stubbed here.
vi.mock('@/app/(app)/performance/onehr/record-insight', () => ({ RecordInsight: ({ reviewId, kind }: { reviewId: string; kind: string }) => <p data-record-insight={`${reviewId}:${kind}`} /> }));
const load = vi.fn<() => Promise<PerformanceHomeBlock | null>>();
const assigned = vi.fn<() => Promise<boolean>>();
vi.mock('@/packs/performance/service', () => ({ getPerformanceHomeBlock: () => load(), hasAssignedPerformanceWork: () => assigned() }));
import { PerformanceAreaHome } from '../components/performance-home/area-home';
import { PerformanceHomeSlot, PerformanceHomeView } from '../components/performance-home/performance-home';

afterEach(() => { cleanup(); delete document.documentElement.dataset.uiTheme; load.mockReset(); assigned.mockReset(); });

const A = en.performanceArea;
const CYCLE = '11111111-1111-4111-8111-111111111111';
const UNIT = '22222222-2222-4222-8222-222222222222';
const BANDS = /\b(UA|BE|ME|AE|OU)\b/;
/** Every text node under a root that carries a band code (text nodes one by one, so no two words run together). */
const bandTexts = (root: Element = document.body) => {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (BANDS.test(node.textContent ?? '')) out.push((node.textContent ?? '').trim());
  return out;
};
const DAY = (iso: string) => createFormatter({ locale: 'en', timeZone: 'UTC' }).dateTime(new Date(`${iso}T00:00:00Z`), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

let n = 0;
const item = (o: Pick<HomeWorkItem, 'kind' | 'view' | 'module' | 'stage'> & Partial<HomeWorkItem>): HomeWorkItem =>
  ({ id: `item-${++n}`, cycleId: CYCLE, state: 'open', title: 'Fictional session', ...o });
const factsOf = (items: HomeWorkItem[], ownFeedbackReport: PerformanceAreaFacts['ownFeedbackReport'] = 'none'): PerformanceAreaFacts =>
  ({ performanceOn: true, ownFeedbackReport, items: items.map(({ kind, cycleId, view, module, stage, axis }) => ({ kind, cycleId, view, module, stage, axis, locked: false })) });

const standing: HomeStanding = { performance: { state: 'notReleased' }, competency: 'withManager', feedback360: 'notReleased', careerTarget: { state: 'notSet' } };
const employeeBlock: PerformanceHomeBlock = {
  cycle: { id: CYCLE, name: 'Fictional year-end', closesOn: '2026-12-31' },
  steps: [{ key: 'kpi', state: 'yourTurn' }, { key: 'competency', state: 'done' }, { key: 'results', state: 'locked' }], done: 1, total: 3,
  next: { kind: 'kpi', done: 1, total: 3, dueOn: '2026-12-31', href: `/performance/workspace?cycle=${CYCLE}&view=mine&module=pm` },
  team: null, standing, detailsHref: '/me/performance',
};
const lmBlock: PerformanceHomeBlock = {
  ...employeeBlock, steps: [...employeeBlock.steps.slice(0, 2), { key: 'teamReview', state: 'waiting', count: 2 }, { key: 'results', state: 'locked' }], total: 4,
  team: { total: 2, chips: [{ kind: 'performanceReview', count: 2 }], href: `/performance/workspace?cycle=${CYCLE}&view=team` },
};
const quietBlock: PerformanceHomeBlock = { ...employeeBlock, next: { kind: 'none', nextDate: { kind: 'closes', on: '2026-12-31' } } };

const bu: Extract<RunningLeaderStatus, { seat: 'bu' }> = {
  seat: 'bu', mode: 'running', cycleId: CYCLE, midYear: false,
  units: [{
    companyId: UNIT, label: 'Fictional unit', people: 12, departments: 3, state: 'part',
    axes: [{ axis: 'performance', state: 'locked', lockedOn: '2026-11-02', in: 3, of: 3 }, { axis: 'potential', state: 'waiting', lockedOn: null, in: 1, of: 3 }],
    depts: [{ name: 'Dept One', performanceInOn: '2026-10-30', potentialInOn: null }, { name: 'Dept Two', performanceInOn: null, potentialInOn: null }, { name: 'Dept Three', performanceInOn: '2026-10-29', potentialInOn: '2026-10-29' }],
  }],
};
const bg: RunningLeaderStatus = {
  seat: 'bg', mode: 'running', cycleId: CYCLE, midYear: false, ready: 1, locked: 1, total: 3,
  rows: [
    { companyId: UNIT, label: 'Unit One', people: 10, state: 'locked', lockedOn: '2026-11-05', in: 2, of: 2 },
    { companyId: '33333333-3333-4333-8333-333333333333', label: 'Unit Two', people: 7, state: 'ready', lockedOn: null, in: 2, of: 2 },
    { companyId: '44444444-4444-4444-8444-444444444444', label: 'Unit Three', people: 4, state: 'calibrating', lockedOn: null, in: 1, of: 2 },
  ],
};
const group: RunningLeaderStatus = {
  seat: 'group', mode: 'running', cycleId: CYCLE, midYear: false, ready: 0, locked: 0, total: 1,
  rows: [{ label: 'Batch A', people: 30, state: 'calibrating', lockedOn: null, in: 12, of: 30 }],
};

function running(p: { block: PerformanceHomeBlock | null; items: HomeWorkItem[]; leader?: LeaderStatus | null; notIn?: { cycleName: string; reason: NotInReason } | null; report?: PerformanceAreaFacts['ownFeedbackReport'] }): AreaHomeView {
  const facts = factsOf(p.items, p.report);
  return {
    mode: 'running', facts,
    rail: p.block ? { cycleId: CYCLE, cycleName: p.block.cycle.name, closesOn: p.block.cycle.closesOn, steps: p.block.steps, done: p.block.done, total: p.block.total }
      : { cycleId: CYCLE, cycleName: 'Fictional year-end', closesOn: '2026-12-31', steps: [{ key: 'calibration', state: 'waiting', count: 1 }], done: 0, total: 1 },
    next: homeNext(p.block, p.items, CYCLE),
    slot: homeSlot({ block: p.block, leader: p.leader ?? null, notIn: p.notIn ?? null, items: p.items, cycleId: CYCLE }),
    past: null, results: null, led: null, plan: null, talentBox: null,
    history: { rows: [{ id: 'old-1', name: 'Fictional 2025 year-end', performance: 'ME', potential: null, talent: null }], fullHref: '/me/performance?recordFor=own&record=current' },
    tools: toolDoors(facts), checkIns: null,
  };
}
const own = () => item({ kind: 'review', view: 'mine', module: 'pm', stage: 'results' });
const teamItems = () => [item({ kind: 'review', view: 'team', module: 'pm', stage: 'moderation', id: 'team-1' }), item({ kind: 'review', view: 'team', module: 'pm', stage: 'results', id: 'team-2', state: 'waiting' })];

const PERSONAS: Record<string, () => AreaHomeView> = {
  employee: () => running({ block: employeeBlock, items: [own()] }),
  lineManager: () => running({ block: lmBlock, items: [own(), ...teamItems()] }),
  hod: () => running({ block: lmBlock, items: [own(), ...teamItems(), item({ kind: 'calibration', view: 'dept', module: 'cal', stage: 'department_review', axis: 'performance', title: 'Fictional department' })] }),
  buCeo: () => running({ block: employeeBlock, leader: bu, items: [own(),
    item({ kind: 'calibration', view: 'bu', module: 'cal', stage: 'calibration', axis: 'performance', title: 'Fictional BU' }),
    item({ kind: 'calibration', view: 'bu', module: 'cal', stage: 'potential_calibration', axis: 'potential', title: 'Fictional BU' }),
    item({ kind: 'calibration', view: 'bu', module: 'cal', stage: 'talent_box', axis: 'both', title: 'Fictional BU' })] }),
  bgCeo: () => running({ block: null, leader: bg, items: [item({ kind: 'calibration', view: 'bg', module: 'cal', stage: 'talent_box', axis: 'both', title: 'Fictional group' })] }),
  groupChief: () => running({ block: null, leader: group, items: [
    item({ kind: 'calibration', view: 'group', module: 'cal', stage: 'group_calibration', axis: 'performance', title: 'Fictional group' }),
    item({ kind: 'calibration', view: 'group', module: 'cal', stage: 'talent_box', axis: 'both', title: 'Fictional group', state: 'done' })] }),
  employeeOut: () => running({ block: null, notIn: { cycleName: 'Fictional year-end', reason: 'unitOut' }, items: [item({ kind: 'feedback', view: 'mine', module: 'tm', stage: 'feedback', id: 'req-1' })] }),
  admin: () => ({ ...running({ block: null, items: [] }), mode: 'record', rail: null, next: null, slot: null, history: { rows: [], fullHref: null } }),
};
const EXPECT: Record<string, { cards: string[]; doors: string[]; solid: number }> = {
  employee: { cards: ['rail', 'next', 'stand', 'tools', 'history'], doors: ['pm.my'], solid: 1 },
  lineManager: { cards: ['rail', 'next', 'stand', 'tools', 'history'], doors: ['pm.my', 'pm.team'], solid: 1 },
  hod: { cards: ['rail', 'next', 'stand', 'tools', 'history'], doors: ['pm.my', 'pm.team', 'calibration.performance'], solid: 1 },
  buCeo: { cards: ['rail', 'next', 'leader', 'tools', 'history'], doors: ['pm.my', 'calibration.performance', 'calibration.potential', 'calibration.talentBox'], solid: 1 },
  bgCeo: { cards: ['rail', 'next', 'leader', 'tools', 'history'], doors: ['calibration.performance', 'calibration.potential', 'calibration.talentBox'], solid: 1 },
  groupChief: { cards: ['rail', 'next', 'leader', 'tools', 'history'], doors: ['calibration.performance', 'calibration.talentBox'], solid: 1 },
  employeeOut: { cards: ['rail', 'next', 'notIn', 'tools', 'history'], doors: ['feedback.assessments'], solid: 1 },
  admin: { cards: ['results', 'tools', 'history'], doors: [], solid: 0 },
};

async function draw(view: AreaHomeView, unit?: string) {
  const tree = await PerformanceAreaHome({ view, unit });
  return render(<NextIntlClientProvider locale="en" messages={en} onError={(e) => { throw e; }}>{tree}</NextIntlClientProvider>);
}
const cards = () => [...document.querySelectorAll<HTMLElement>('[data-home-card]')].map((e) => e.dataset.homeCard);
const solid = () => [...document.querySelectorAll<HTMLElement>('a, button')].filter((e) => e.classList.contains('bg-primary'));
const doors = () => [...document.querySelectorAll<HTMLElement>('[data-door]')].map((e) => e.dataset.door);
const card = (id: string) => document.querySelector<HTMLElement>(`[data-home-card="${id}"]`)!;

describe('card order, conditions, the one solid button and the doors, per persona', () => {
  it.each(Object.keys(PERSONAS))('%s', async (persona) => {
    await draw(PERSONAS[persona]!());
    const want = EXPECT[persona]!;
    expect(cards()).toEqual(want.cards);
    expect(solid()).toHaveLength(want.solid);
    expect(doors()).toEqual(want.doors);
    // The area's Dashboard tab strip is on top, lit.
    const strip = screen.getByRole('navigation', { name: A.tabs.home });
    expect(within(strip).getByRole('link', { name: A.tabs.home }).getAttribute('aria-current')).toBe('page');
    expect(strip.compareDocumentPosition(document.querySelector('[data-home-card]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Learning is never drawn (D6); the deferred Talent Box card has no placeholder (DQ-6).
    expect(document.body.textContent).not.toMatch(/Learning|Talent Box ·/);
  });

  it('the one solid button is the own next step; the team row is an outline button', async () => {
    await draw(PERSONAS.lineManager!());
    expect(solid()[0]?.getAttribute('href')).toBe(employeeBlock.next.kind === 'kpi' ? employeeBlock.next.href : '');
    const team = card('next').querySelector('[data-row="team"]') as HTMLElement;
    expect(within(team).getByRole('link', { name: en.performanceHome.team.open }).classList.contains('bg-primary')).toBe(false);
    expect(within(card('next')).getByText(A.home.next.title)).toBeTruthy();
  });

  it('with nothing to do: "You are here", "Nothing needs you right now", and no solid button', async () => {
    await draw(running({ block: quietBlock, items: [own()] }));
    expect(within(card('next')).getByText(A.home.next.here)).toBeTruthy();
    expect(within(card('next')).getByRole('heading', { name: A.home.next.none })).toBeTruthy();
    expect(solid()).toHaveLength(0);
  });

  it('a BG CEO outside any own review gets the leader card, not the not-in card; the lead row takes the button', async () => {
    await draw(PERSONAS.bgCeo!());
    expect(document.querySelector('[data-home-card="notIn"]')).toBeNull();
    expect(solid()[0]?.getAttribute('href')).toMatch(/^\/performance\/assessment\/calibration\/item-\d+$/);
  });
});

describe('Your tools: the Check-ins door to /performance (DQ-11)', () => {
  it('a manager with check-ins waiting there gets the door; an employee does not', async () => {
    const { unmount } = await draw({ ...PERSONAS.lineManager!(), checkIns: '/performance' });
    const door = card('tools').querySelector<HTMLAnchorElement>('[data-door="checkIns"]');
    expect(door?.getAttribute('href')).toBe('/performance');
    expect(door?.textContent).toContain(A.home.tools.checkIns);
    expect(doors()).toEqual(['pm.my', 'pm.team', 'checkIns']);
    unmount();
    await draw(PERSONAS.employee!());
    expect(card('tools').querySelector('[data-door="checkIns"]')).toBeNull();
    expect(screen.queryByText(A.home.tools.checkIns)).toBeNull();
  });
  it('the door alone still fills Your tools (no empty line)', async () => {
    await draw({ ...PERSONAS.admin!(), checkIns: '/performance' });
    expect(doors()).toEqual(['checkIns']);
    expect(card('tools').textContent).not.toContain(A.homeHelp.tools.emptyLine);
  });
});

describe('Where you stand', () => {
  it('never shows an unreleased band to an employee, nor any band on a leader\'s page', async () => {
    const { unmount } = await draw(PERSONAS.employee!());
    expect(card('stand').querySelector('[data-standing="performance"]')?.textContent).toBe(`${A.home.stand.rows.performance}${A.home.stand.values.notReleased}`);
    // The history row's released band is the only band on the page.
    expect(bandTexts()).toEqual(['ME']);
    expect(bandTexts(card('history'))).toEqual(['ME']);
    unmount();
    await draw({ ...PERSONAS.buCeo!(), history: { rows: [], fullHref: null } });
    expect(document.querySelector('[data-home-card="stand"]')).toBeNull();
    expect(document.body.textContent?.length).toBeGreaterThan(200);
    expect(bandTexts()).toEqual([]);
  });

  it('DQ-1: the line-manager-approved row shows the band with its note; the default rows show words only', async () => {
    const view = (performance: HomeStanding['performance']) => running({ block: { ...employeeBlock, standing: { ...standing, performance } }, items: [own()] });
    const { unmount } = await draw(view({ state: 'lineManagerApproved', band: 'AE' }));
    const row = card('stand').querySelector('[data-standing="performance"]') as HTMLElement;
    expect(row.textContent).toBe(`${A.home.stand.rows.performance}AE${A.homeHelp.stand.lineManagerApproved}`);
    expect(row.querySelector('dd')?.classList.contains('font-semibold')).toBe(false);
    unmount();
    for (const state of ['awaitingManager', 'notReleased'] as const) {
      const r = await draw(view({ state }));
      expect(bandTexts(card('stand'))).toEqual([]);
      expect(card('stand').querySelector('[data-standing="performance"]')?.textContent).toBe(`${A.home.stand.rows.performance}${A.home.stand.values[state]}`);
      r.unmount();
    }
    await draw(view({ state: 'released', band: 'OU' }));
    expect(card('stand').querySelector('[data-standing="performance"] dd')?.classList.contains('font-semibold')).toBe(true);
  });

  it('reads competency as "{done} of {total} demonstrated" once reviewed', async () => {
    await draw(running({ block: { ...employeeBlock, standing: { ...standing, competency: 'reviewed', competencyDemonstrated: { done: 4, total: 6 } } }, items: [own()] }));
    expect(card('stand').querySelector('[data-standing="competency"]')?.textContent).toBe(`${A.home.stand.rows.competency}4 of 6 demonstrated`);
  });
});

describe('the leader card, by seat', () => {
  it('BU CEO: "Where your BU is", each axis ready to lock or not, departments scrolling inside the card', async () => {
    await draw(PERSONAS.buCeo!());
    const c = card('leader');
    expect(c.dataset.seat).toBe('bu');
    expect(within(c).getByRole('heading', { name: A.home.bu.title })).toBeTruthy();
    expect(c.querySelector('[data-axis="performance"]')?.textContent).toContain(`Locked ${DAY('2026-11-02')}`);
    expect(c.querySelector('[data-axis="potential"]')?.textContent).toContain(A.home.axis.notReady);
    expect(c.querySelector('[data-axis="potential"]')?.textContent).toContain('1 of 3 department reviews in');
    const scroll = c.querySelector('[data-scroll-inside]') as HTMLElement;
    expect(scroll.className).toMatch(/\bmax-h-72\b/);
    expect(scroll.className).toMatch(/\boverflow-y-auto\b/);
    expect(scroll.getAttribute('tabindex')).toBe('0');
    expect([...scroll.querySelectorAll('[role="row"]')].map((r) => r.textContent)).toEqual([
      `Dept One✓ in ${DAY('2026-10-30')}to submit`, 'Dept Twoto submitto submit', `Dept Three✓ in ${DAY('2026-10-29')}✓ in ${DAY('2026-10-29')}`,
    ]);
    expect(c.querySelector('nav')).toBeNull(); // one unit: no unit picker
  });

  it('BU CEO of several units: a picker, and ?unit= selects one', async () => {
    const two: RunningLeaderStatus = { ...bu, units: [...bu.units, { companyId: '55555555-5555-4555-8555-555555555555', label: 'Second unit', people: 3, departments: 1, state: 'open', axes: [], depts: [] }] };
    await draw(running({ block: employeeBlock, leader: two, items: [own()] }), '55555555-5555-4555-8555-555555555555');
    const picker = within(card('leader')).getByRole('navigation', { name: A.homeHelp.leader.units });
    expect(within(picker).getAllByRole('link').map((l) => [l.textContent, l.getAttribute('aria-current')])).toEqual([['Fictional unit· In progress', null], ['Second unit· To do', 'true']]);
    expect(card('leader').textContent).toContain('3 people · 1 department');
  });

  it('BG CEO: "Where the group is", business unit by business unit', async () => {
    await draw(PERSONAS.bgCeo!());
    const c = card('leader');
    expect(within(c).getByRole('heading', { name: A.home.bg.title })).toBeTruthy();
    expect(c.textContent).toContain('1 of 3 ready · 1 locked');
    expect([...c.querySelectorAll('[data-row-state]')].map((r) => r.textContent)).toEqual([
      `Unit One10 people${`Locked ${DAY('2026-11-05')}`}`, `Unit Two7 people${A.home.axis.ready}`, `Unit Three4 people · 1 of 2 in${A.home.bg.calibrating}`,
    ]);
  });

  it('Group Chief: "Where your group is", batch by batch', async () => {
    await draw(PERSONAS.groupChief!());
    const c = card('leader');
    expect(within(c).getByRole('heading', { name: A.home.group.title })).toBeTruthy();
    expect(c.textContent).toContain(`${A.home.bg.columns.batch} · ${A.home.bg.columns.ratings}`);
    expect([...c.querySelectorAll('[data-row-state]')].map((r) => r.textContent)).toEqual([`Batch A30 people · 12 of 30 in${A.home.bg.calibrating}`]);
  });
});

describe('not in this cycle\'s review', () => {
  it('says why (the unit rule) and what is still theirs', async () => {
    await draw(PERSONAS.employeeOut!());
    const c = card('notIn');
    expect(within(c).getByRole('heading', { name: A.home.notIn.title })).toBeTruthy();
    expect(c.textContent).toContain('Your own review is not part of Fictional year-end: your unit is not taking part in this cycle.');
    expect(c.textContent).toContain(A.homeHelp.notIn.nothingOwn);
    expect(solid()[0]?.getAttribute('href')).toBe('/performance/assessment/feedback/req-1');
  });

  it('a leader outside their own review sees their team\'s tally', async () => {
    await draw(running({ block: null, notIn: { cycleName: 'Fictional year-end', reason: 'probation' }, items: teamItems() }));
    const c = card('notIn');
    expect(c.textContent).toContain('you are still on probation');
    expect(c.textContent).toContain(A.homeHelp.notIn.leads);
    expect([...c.querySelectorAll('[data-count]')].map((d) => d.textContent)).toEqual([`${A.home.notIn.counts.waitingOnYou}1`, `${A.home.notIn.counts.stillWriting}1`, `${A.home.notIn.counts.done}0`]);
  });
});

describe('between cycles', () => {
  const record = (): AreaHomeView => ({
    ...PERSONAS.admin!(),
    past: { cycleName: 'Fictional 2025 year-end', steps: [{ key: 'kpi', done: true }, { key: 'competency', done: false }, { key: 'results', done: true }] },
    results: { id: 'rev-old', name: 'Fictional 2025 year-end', performance: 'ME', potential: null, talent: null, recordHref: '/me/performance?recordFor=rev-old&record=rev-old', reportHref: null },
    plan: { year: 2026, status: 'shared', goals: [{ id: 'g1', area: 'Lead a fictional project', status: 'in_progress' }], href: '/performance/plan' },
  });
  it('the last journey, released results with the existing AI read, this year\'s plan holding the one solid button', async () => {
    await draw(record());
    expect(cards()).toEqual(['past', 'results', 'plan', 'tools', 'history']);
    expect(card('past').textContent).toContain('Fictional 2025 year-end: your journey through it');
    expect(card('past').textContent).toContain('Closed · 2 of 3 steps');
    expect([...card('results').querySelectorAll('[data-result]')].map((d) => d.textContent)).toEqual([
      `${A.home.results.tiles.performance}ME`, `${A.home.results.tiles.potential}${A.home.stand.values.notReleased}`, `${A.home.results.tiles.talent}${A.home.stand.values.notReleased}`,
    ]);
    expect(card('results').querySelector('[data-record-insight]')?.getAttribute('data-record-insight')).toBe('rev-old:cycle');
    expect(within(card('results')).queryByRole('link', { name: A.home.results.report })).toBeNull();
    expect(solid().map((s) => s.textContent)).toEqual([A.home.plan.open]);
  });
  it('someone with no record yet: "Your record starts here" and no button', async () => {
    await draw(PERSONAS.admin!());
    expect(within(card('results')).getByRole('heading', { name: A.home.results.empty })).toBeTruthy();
    expect(card('tools').textContent).toContain(A.homeHelp.tools.emptyLine);
  });
});

describe('layout', () => {
  it('two columns from lg up; one stacked column below (390px)', async () => {
    await draw(PERSONAS.buCeo!());
    const grid = document.querySelector('[data-home-columns]') as HTMLElement;
    const cols = [...grid.classList].filter((c) => c.includes('grid-cols'));
    expect(cols).toContain('grid-cols-1');
    expect(cols.filter((c) => c !== 'grid-cols-1').every((c) => c.startsWith('lg:'))).toBe(true);
    expect([...grid.children].map((c) => (c as HTMLElement).dataset.homeColumn)).toEqual(['main', 'side']);
    expect([...grid.querySelectorAll('[data-home-column="main"] > [data-home-card]')].map((e) => (e as HTMLElement).dataset.homeCard)).toEqual(['next', 'leader']);
    expect([...grid.querySelectorAll('[data-home-column="side"] > [data-home-card]')].map((e) => (e as HTMLElement).dataset.homeCard)).toEqual(['tools']);
  });
});

describe('the AI-HR home "Your review" card', () => {
  it.each(['classic', 'monolith', 'atelier'])('heads the Performance block under the %s theme and opens /performance/home', async (theme) => {
    if (theme !== 'classic') document.documentElement.dataset.uiTheme = theme;
    render(await PerformanceHomeView({ block: employeeBlock }));
    const c = document.querySelector('[data-performance-review-card]') as HTMLElement;
    expect(within(c).getByRole('heading', { name: A.homeCard.title })).toBeTruthy();
    expect(within(c).getByRole('link').getAttribute('href')).toBe('/performance/home');
    expect(within(c).getByRole('link').textContent).toContain(en.nav.performanceTalent);
    expect(c.compareDocumentPosition(document.querySelector('[data-performance-strip]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('without an own open review: the card alone when work is assigned, nothing otherwise', async () => {
    load.mockResolvedValue(null);
    assigned.mockResolvedValueOnce(true);
    const tree = await PerformanceHomeSlot({ session: {} as never, scopeIds: undefined });
    render(<>{tree}</>);
    expect(document.querySelector('[data-performance-review-card] a')?.getAttribute('href')).toBe('/performance/home');
    expect(document.querySelector('[data-performance-strip]')).toBeNull();
    cleanup();
    assigned.mockResolvedValueOnce(false);
    expect(await PerformanceHomeSlot({ session: {} as never, scopeIds: undefined })).toBeNull();
  });
});
