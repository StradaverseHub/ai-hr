/**
 * D-P1-32 PT-X4 (APR-025 D5, P1-05 §7.3) — the performance admin area, rendered. Every part of the old cycle page
 * renders in exactly one admin page (and the old page still renders every card whole), each section draws its
 * tabs from the registry, the policy form is whole on Cycle › Calendar, each Run page's progress is fixed to its
 * module, a save comes back to the page it was made on, and a crafted address or a cycle outside the session's
 * reach is a 404. The card components themselves are stubbed: their own tests cover them; this file pins where
 * they land. Registry rules (pure) are test/performance-admin-sections.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';
import en from '../messages/en.json';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';

const ports = vi.hoisted(() => ({ cycle: vi.fn(), adminCycle: vi.fn(), onehrOnly: vi.fn(), guard: vi.fn() }));
vi.mock('next-intl/server', () => ({ getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: en, namespace: namespace as never }), getLocale: async () => 'en' }));
vi.mock('next/navigation', async (importActual) => ({ ...await importActual<typeof import('next/navigation')>(), notFound: () => { throw new Error('NOT_FOUND'); }, useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('../lib/authz', () => ({ requireOnehrAdminAccess: ports.guard, isOnehrOnlyPerformanceAdmin: ports.onehrOnly }));
vi.mock('../packs/performance/service', () => ({ getOnehrCycle: ports.cycle, isOnehrAdminCycle: ports.adminCycle }));
vi.mock('../core/performance', () => ({ calibrationView: vi.fn(), cycleDetail: vi.fn() }));
vi.mock('../core/payroll', () => ({ listBatches: vi.fn() }));
vi.mock('../core/entitlements', () => ({ isModuleEnabledOrFalse: vi.fn() }));
vi.mock('../app/(app)/performance/actions', () => ({ openCycleAction: vi.fn(), calibrateAction: vi.fn(), closeAction: vi.fn(), closeReviewAction: vi.fn(), commitCalibrationAction: vi.fn(), declineAction: vi.fn(), enactAction: vi.fn(), openCalibrationAction: vi.fn(), proposeCalibrationAction: vi.fn(), releaseAction: vi.fn() }));
vi.mock('../app/(app)/performance/onehr-actions', () => ({ onehrCycleAction: vi.fn(), enableOnehrAction: vi.fn() }));
vi.mock('../app/(app)/performance/onehr/admin-assistant', () => ({ PerformanceAdminAssistant: () => <div data-stub="assistant" /> }));
vi.mock('../app/(app)/performance/onehr/unit-exclusion-admin', () => ({ UnitExclusionAdmin: () => <div data-stub="units" /> }));
vi.mock('../app/(app)/performance/onehr/progress-admin', () => ({ AssessmentProgressAdmin: ({ initial, fixed }: { initial?: { progressModule?: string; progressKind?: string; progressGroup?: string }; fixed?: boolean }) => <div data-stub="progress" data-module={initial?.progressModule ?? ''} data-kind={initial?.progressKind ?? ''} data-group={initial?.progressGroup ?? ''} data-fixed={String(!!fixed)} /> }));
vi.mock('../app/(app)/performance/onehr/panel-admin', () => ({ PanelAdmin: () => <div data-stub="panels" /> }));
vi.mock('../app/(app)/performance/onehr/framework-admin', () => ({ FrameworkAdmin: ({ returnTo }: { returnTo?: string }) => <div data-stub="framework" data-return={returnTo ?? ''} /> }));
vi.mock('../app/(app)/performance/onehr/catalogue-admin', () => ({ CatalogueAdmin: ({ sections, returnTo }: { sections?: readonly string[]; returnTo?: string }) => <div data-stub="catalogue" data-sections={sections ? sections.join(',') : 'all'} data-return={returnTo ?? ''} /> }));
vi.mock('../app/(app)/performance/onehr/participants', () => ({ AssessmentParticipants: ({ returnTo }: { returnTo?: string }) => <div data-stub="participants" data-return={returnTo ?? ''} /> }));
vi.mock('../app/(app)/performance/onehr/company-kpi', () => ({ CompanyKpiFill: () => <div data-stub="companyKpi" /> }));
vi.mock('../app/(app)/performance/onehr/kpi-import', () => ({ AssessmentKpiImport: () => <div data-stub="kpiImport" /> }));
vi.mock('../app/(app)/performance/onehr/reminder-admin', () => ({ AssessmentReminderAdmin: ({ returnTo }: { returnTo?: string }) => <div data-stub="reminders" data-return={returnTo ?? ''} /> }));
vi.mock('../app/(app)/performance/leaders/generate-scopes', () => ({ GenerateCalibrationScopes: () => <div data-stub="scopes" /> }));
vi.mock('../app/(app)/performance/onehr/module-overview', () => ({ ModuleOverview: ({ module, section }: { module: string; section: string }) => <div data-stub="overview" data-module={module} data-section={section} /> }));
vi.mock('../app/(app)/performance/onehr/admin-cycles', () => ({ AdminAllCycles: ({ basePath }: { basePath: string }) => <div data-stub="allCycles" data-base={basePath} /> }));
import { OnehrCycleView } from '../app/(app)/performance/onehr/cycle-view';
import { PerformanceAdminShell } from '../app/(app)/performance/onehr/admin-shell';
import PerformanceAdminPage from '../app/(app)/performance/[cycleId]/[section]/[tab]/page';
import CyclePage from '../app/(app)/performance/[cycleId]/page';
import { adminCards, adminPageHref, adminSectionHref, adminSectionList, visibleAdminPages, type AdminPart } from '../packs/performance/onehr/admin-sections';

type View = Parameters<typeof OnehrCycleView>[0]['v'];
type ShellProps = Parameters<typeof PerformanceAdminShell>[0];
const CYCLE = '11111111-2222-4333-8444-555555555555';
const pa = en.performanceAdmin as unknown as { title: string; empty: string; sections: Record<string, string>; tabs: Record<string, string>; pages: Record<string, string>; nav: Record<string, string>; groups: Record<string, string> };
const allParts = adminCards.flatMap((c) => [...c.parts] as AdminPart[]);
function cycle(over: { status?: string; modules?: Partial<View['policy']['modules']>; kind?: View['policy']['kind'] } = {}): View {
  const base = defaultPolicy(framework);
  const policy = { ...base, kind: over.kind ?? 'year_end', modules: { pm: true, tm: true, idp: true, evidence: false, calibration: true, review: false, ...over.modules } };
  return {
    cycle: { id: CYCLE, name: '2026 Year-End', status: over.status ?? 'open', companyId: null }, policy, revision: 3, participants: [],
    reviews: [{ reviewId: 'review-1', employmentId: 'employment-1', name: 'Ann Lee', grade: '10', managerPerformance: null, frozenId: null }],
    companies: [{ id: 'company-1', name: 'Unit A', profitEligible: true }], kpiNames: ['Sales'], profitAchievements: [],
    sessions: [{ id: 'session-1', name: 'Group review', tier: 'group', lockedAt: null }], users: [{ id: 'user-1', name: 'HR Admin', email: null }],
  } as unknown as View;
}
const show = (node: ReactNode) => render(<NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>);
const call = (section: string, tab: string, query: Record<string, string> = {}, cycleId = CYCLE) => PerformanceAdminPage({ params: Promise.resolve({ cycleId, section, tab }), searchParams: Promise.resolve(query) });
async function tabPage(section: string, tab: string, query: Record<string, string> = {}) {
  const el = (await call(section, tab, query)) as ReactElement<ShellProps>;
  expect(el.type).toBe(PerformanceAdminShell);
  return show(await PerformanceAdminShell(el.props));
}
const partsIn = (root: ParentNode) => [...root.querySelectorAll('[data-admin-part]')].map((e) => e.getAttribute('data-admin-part'));
const cardPages = () => adminSectionList.flatMap((s) => s.tabs.flatMap((t) => visibleAdminPages(t).filter((p) => !p.route).map((p, i) => ({ s, t, p, query: i ? { sub: p.key } : {} as Record<string, string> }))));

beforeEach(() => {
  vi.clearAllMocks();
  ports.guard.mockResolvedValue({ tenantId: 'tenant', roles: ['hr_admin'] });
  ports.onehrOnly.mockReturnValue(false);
  ports.adminCycle.mockResolvedValue(true);
  ports.cycle.mockResolvedValue(cycle());
});

describe('the inventory, rendered', () => {
  it('the old cycle page still draws every card whole, in its order, with nothing outside the registry', async () => {
    const ui = show(await OnehrCycleView({ v: cycle() }));
    expect([...ui.container.querySelectorAll('[data-admin-card]')].map((e) => e.getAttribute('data-admin-card'))).toEqual(adminCards.map((c) => c.id));
    const page = ui.container.firstElementChild!;
    const strays = [...page.children].filter((e) => !e.hasAttribute('data-admin-card') && !e.hasAttribute('data-page-header') && e.getAttribute('data-stub') !== 'assistant');
    expect(strays.map((e) => e.outerHTML.slice(0, 80))).toEqual([]);
    expect(page.querySelector('[data-admin-card="progress"] [data-stub="progress"]')?.getAttribute('data-fixed')).toBe('false');
    expect(page.querySelector('[data-admin-card="catalogue"] [data-stub="catalogue"]')?.getAttribute('data-sections')).toBe('all');
    const calibration = page.querySelector<HTMLElement>('[data-admin-card="calibration"]')!;
    expect(within(calibration).getByRole('link', { name: /Group review/ })).toHaveAttribute('href', '/performance/assessment/calibration/session-1');
    expect(calibration.querySelector('[data-stub="scopes"]')).not.toBeNull();
    expect(calibration.querySelector('input[name="action"][value="calibration"]')).not.toBeNull();
    // Its forms come back to it, as they always have: no return path rides them.
    expect(page.querySelectorAll('input[name="returnTo"]')).toHaveLength(0);
    expect(screen.getByRole('link', { name: `${pa.title} →` })).toHaveAttribute('href', `/performance/${CYCLE}/cycle/calendar`);
  });

  it('draws every part of the old cycle page in exactly one admin page, and each page draws exactly its parts', async () => {
    const seen = new Map<string, string[]>();
    for (const { s, t, p, query } of cardPages()) {
      const ui = await tabPage(s.key, t.key, query), at = `${s.key}/${t.key}/${p.key}`;
      expect(partsIn(ui.container), at).toEqual(p.parts);
      for (const part of partsIn(ui.container)) seen.set(part!, [...(seen.get(part!) ?? []), at]);
      ui.unmount();
    }
    expect([...seen.keys()].sort()).toEqual([...allParts].sort());
    for (const [part, at] of seen) expect(at, part).toHaveLength(1);
    expect(ports.cycle).toHaveBeenCalledTimes(cardPages().length);
  });

  it('keeps the policy form whole on Cycle › Calendar and nowhere else (DQ-4)', async () => {
    const found: string[] = [];
    for (const { s, t, p, query } of cardPages()) {
      const ui = await tabPage(s.key, t.key, query);
      const forms = [...ui.container.querySelectorAll('input[name="action"][value="policy"]')].map((input) => input.closest('form')!);
      if (forms.length) found.push(`${s.key}/${t.key}/${p.key}:${forms.length}`);
      if (s.key === 'cycle' && t.key === 'calendar') {
        const names = new Set([...forms[0].elements].map((e) => (e as HTMLInputElement).name));
        for (const name of ['kind', 'pm', 'tm', 'idp', 'evidence', 'calibration', 'review', 'curveToleranceMode', 'lowMaxPct', 'midMaxPct', 'minValid', 'panelTarget', 'idpMinGoals', 'idpMaxGoals', 'curveTolerancePct', 'curveTolerancePeople', 'idpRequireAllActions', 'curveStrict', 'a.0', 'a.4', 'b.company-1.variant', 'b.company-1.0', 'pm_results.opens', 'tb_bgceo.closes', 'extremes', 'bonus', 'penalty', 'catalogue', 'cycleId', 'revision', 'returnTo']) expect(names.has(name), name).toBe(true);
        expect([...names].some((n) => n.startsWith('weight.'))).toBe(true);
        expect((forms[0].querySelector('input[name="returnTo"]') as HTMLInputElement).value).toBe(`/performance/${CYCLE}/cycle/calendar`);
      }
      ui.unmount();
    }
    expect(found).toEqual(['cycle/calendar/calendar:1']);
  });

  it('fixes each Run page\'s progress to its module and kind, and passes the place filters through', async () => {
    const expected: Record<string, [string, string]> = { 'performance/run/': ['pm', 'assessments'], 'feedback/run/': ['feedback', 'assessments'], 'feedback/run/raterProgress': ['feedback', 'assessors'], 'competency/run/': ['competency', 'assessments'], 'calibration/run/': ['calibration', 'assessments'], 'career/run/': ['career', 'assessments'] };
    for (const [key, [module, kind]] of Object.entries(expected)) {
      const [section, tab, sub] = key.split('/');
      const ui = await tabPage(section, tab, { ...(sub ? { sub } : {}), progressGroup: 'Group A' });
      const stubs = ui.container.querySelectorAll('[data-stub="progress"]');
      expect(stubs, key).toHaveLength(1);
      expect([stubs[0].getAttribute('data-module'), stubs[0].getAttribute('data-kind'), stubs[0].getAttribute('data-fixed'), stubs[0].getAttribute('data-group')], key).toEqual([module, kind, 'true', 'Group A']);
      ui.unmount();
    }
  });

  it('splits the competency architecture card by section, and every save comes back to its own page', async () => {
    const expected: Record<string, string> = { 'competency/run/assignCompetencies': 'generate', 'competency/run/importJobCodes': 'import', 'competency/settings/': 'profiles', 'career/settings/': 'routes' };
    for (const [key, sections] of Object.entries(expected)) {
      const [section, tab, sub] = key.split('/'), ui = await tabPage(section, tab, sub ? { sub } : {});
      const stub = ui.container.querySelector('[data-stub="catalogue"]')!;
      expect(stub.getAttribute('data-sections'), key).toBe(sections);
      expect(stub.getAttribute('data-return'), key).toBe(adminPageHref(CYCLE, section, tab, sub || undefined));
      ui.unmount();
    }
    for (const [section, tab, stub] of [['feedback', 'settings', 'framework'], ['cycle', 'participants', 'participants'], ['email', 'schedule', 'reminders']]) {
      const ui = await tabPage(section, tab);
      expect(ui.container.querySelector(`[data-stub="${stub}"]`)?.getAttribute('data-return'), stub).toBe(adminPageHref(CYCLE, section, tab));
      ui.unmount();
    }
    const ui = await tabPage('calibration', 'settings', { sub: 'calibrationGroups' });
    expect((ui.container.querySelector('form input[name="returnTo"]') as HTMLInputElement).value).toBe(`/performance/${CYCLE}/calibration/settings?sub=calibrationGroups`);
  });

  it('draws the one module Overview keyed by each module, All cycles at its own address, and points Performance › Settings at the policy', async () => {
    for (const s of adminSectionList.filter((x) => x.module)) {
      const ui = await tabPage(s.key, 'overview');
      const stub = ui.container.querySelector('[data-stub="overview"]')!;
      expect([stub.getAttribute('data-module'), stub.getAttribute('data-section')]).toEqual([s.module, s.key]);
      ui.unmount();
    }
    let ui = await tabPage('cycle', 'cycles');
    expect(ui.container.querySelector('[data-stub="allCycles"]')?.getAttribute('data-base')).toBe(`/performance/${CYCLE}/cycle/cycles`);
    ui.unmount();
    ui = await tabPage('performance', 'settings');
    expect(screen.getByRole('link', { name: `${pa.sections.cycle} › ${pa.tabs.calendar} →` })).toHaveAttribute('href', `/performance/${CYCLE}/cycle/calendar#policy`);
    expect(partsIn(ui.container)).toEqual([]);
  });

  it('says so when nothing on a page applies to the cycle yet', async () => {
    ports.cycle.mockResolvedValue(cycle({ status: 'draft' }));
    const ui = await tabPage('performance', 'run', { sub: 'fillBuKpi' });
    expect(partsIn(ui.container)).toEqual([]);
    expect(screen.getByText(pa.empty)).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: pa.nav.pages })).getAllByRole('link').map((a) => a.textContent)).toEqual([pa.pages.progress, pa.pages.importKpiTargets, pa.pages.fillBuKpi]);
  });
});

describe('the frame: sections, tabs and pages from the one registry', () => {
  it('lists every section on the left and draws each section\'s own tabs', async () => {
    for (const s of adminSectionList) {
      const ui = show(await PerformanceAdminShell({ cycleId: CYCLE, cycleName: '2026 Year-End', section: s.key, tab: s.tabs[0].key, children: null }));
      const side = within(screen.getByRole('navigation', { name: pa.nav.sections }));
      expect(side.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual(adminSectionList.map((x) => [pa.sections[x.key], adminSectionHref(CYCLE, x.key)]));
      expect(side.getByRole('link', { name: pa.sections[s.key] })).toHaveAttribute('aria-current', 'true');
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(pa.sections[s.key]);
      const tabs = within(screen.getByRole('navigation', { name: pa.sections[s.key] }));
      expect(tabs.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]), s.key).toEqual(s.tabs.map((t) => [pa.tabs[t.key], adminPageHref(CYCLE, s.key, t.key)]));
      expect(tabs.getByRole('link', { name: pa.tabs[s.tabs[0].key] })).toHaveAttribute('aria-current');
      ui.unmount();
    }
    expect(within(show(await PerformanceAdminShell({ cycleId: CYCLE, section: 'competency', tab: 'run', children: null })).container).getByText(pa.groups.modules)).toBeInTheDocument();
  });

  it('lists a tab\'s pages under it when it holds more than one, and marks the open one', async () => {
    show(await PerformanceAdminShell({ cycleId: CYCLE, section: 'feedback', tab: 'run', page: 'raterProgress', children: null }));
    const pages = within(screen.getByRole('navigation', { name: pa.nav.pages }));
    expect(pages.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      [pa.pages.people, `/performance/${CYCLE}/feedback/run`], [pa.pages.raterProgress, `/performance/${CYCLE}/feedback/run?sub=raterProgress`], [pa.pages.panels, `/performance/${CYCLE}/feedback/run?sub=panels`],
    ]);
    expect(pages.getByRole('link', { name: pa.pages.raterProgress })).toHaveAttribute('aria-current', 'page');
  });

  it('draws no page row for a one-page tab, nor for a hidden page (the agent report under Reports)', async () => {
    show(await PerformanceAdminShell({ cycleId: CYCLE, section: 'reports', tab: 'reports', page: 'builtByAgent', children: null }));
    expect(screen.queryByRole('navigation', { name: pa.nav.pages })).toBeNull();
    expect(within(screen.getByRole('navigation', { name: pa.sections.reports })).getByRole('link', { name: pa.tabs.reports })).toHaveAttribute('href', `/performance/${CYCLE}/records`);
    await expect(PerformanceAdminShell({ cycleId: CYCLE, section: 'learning', tab: 'overview', children: null })).rejects.toThrow();
  });

  it('says whether a module is on for this cycle', async () => {
    let ui = await tabPage('performance', 'overview');
    expect(screen.getByText('On for 2026 Year-End')).toBeInTheDocument();
    ui.unmount();
    ports.cycle.mockResolvedValue(cycle({ modules: { idp: false } }));
    ui = await tabPage('career', 'run');
    expect(screen.getByText('Off for 2026 Year-End')).toBeInTheDocument();
    ui.unmount();
    ui = await tabPage('cycle', 'calendar');
    expect(screen.queryByText(/^O(n|ff) for /)).toBeNull();
  });
});

describe('who may open which address', () => {
  it('refuses any address the registry does not hold as a card page, before reading the cycle', async () => {
    for (const [section, tab, query, cycleId] of [
      ['learning', 'overview', {}, CYCLE], ['cycle', 'reminders', {}, CYCLE], ['cycle', 'release', {}, CYCLE], ['reports', 'reports', {}, CYCLE],
      ['reports', 'reports', { sub: 'builtByAgent' }, CYCLE], ['feedback', 'run', { sub: 'bogus' }, CYCLE], ['performance', 'run', { sub: 'panels' }, CYCLE],
      ['cycle', 'calendar', {}, 'not-a-cycle'],
    ] as const) {
      await expect(call(section, tab, query, cycleId), `${section}/${tab}`).rejects.toThrow('NOT_FOUND');
    }
    expect(ports.cycle).not.toHaveBeenCalled();
    expect(ports.guard).toHaveBeenCalledTimes(8);
  });

  it('gives the OneHR performance partner only the OneHR-native cycles it administers', async () => {
    ports.onehrOnly.mockReturnValue(true);
    ports.adminCycle.mockResolvedValue(false);
    await expect(call('cycle', 'calendar')).rejects.toThrow('NOT_FOUND');
    expect(ports.cycle).not.toHaveBeenCalled();
    ports.adminCycle.mockResolvedValue(true);
    expect(((await call('cycle', 'calendar')) as ReactElement).type).toBe(PerformanceAdminShell);
    expect(ports.adminCycle).toHaveBeenLastCalledWith(expect.anything(), CYCLE);
  });

  it('has no admin pages for a cycle that is not OneHR-native', async () => {
    ports.cycle.mockResolvedValue(null);
    await expect(call('cycle', 'calendar')).rejects.toThrow('NOT_FOUND');
    expect(ports.adminCycle).not.toHaveBeenCalled(); // an HR administrator is not the partner: the cycle read decides
  });

  it('keeps /performance/[cycleId] working: a OneHR cycle still opens the whole cycle page (D8)', async () => {
    const v = cycle();
    ports.cycle.mockResolvedValue(v);
    const el = (await CyclePage({ params: Promise.resolve({ cycleId: CYCLE }), searchParams: Promise.resolve({ progressModule: 'competency' }) })) as ReactElement<Parameters<typeof OnehrCycleView>[0]>;
    expect(el.type).toBe(OnehrCycleView);
    expect(el.props.v).toBe(v);
    expect(el.props.initialProgress).toEqual({ progressModule: 'competency' });
  });
});
