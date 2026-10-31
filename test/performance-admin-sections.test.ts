/**
 * D-P1-32 PT-X4 (APR-025 D5, P1-05 §7.3) — the performance admin area's ONE registry
 * (packs/performance/onehr/admin-sections.ts). Pure: the section › tab › page exact set, the inventory of the old
 * cycle page's cards (every part in exactly one page), the visibility rules the cycle page has always applied,
 * the return-path gate the cycle forms use, the labels in six locales, and the route's registration and guards.
 * The rendered side (each tab draws its parts, the policy form whole on Calendar) is
 * test/performance-admin-area.dom.test.tsx.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adminCardShown, adminCards, adminPageHref, adminPartHome, adminPartShown, adminReturnPath, adminSectionHref, adminSectionList,
  resolveAdminTab, visibleAdminPages, type AdminCycleState, type AdminPart,
} from '../packs/performance/onehr/admin-sections';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { assessmentProgress, progressModules, progressStages, type ProgressModule } from '../packs/performance/onehr/progress-model';
import { overviewModuleOn, overviewModules, overviewProgressModule } from '../packs/performance/onehr/overview-model';
import { SCREENS } from '../lib/permissions';
import en from '../messages/en.json';

const ROOT = path.resolve(__dirname, '..');
const CYCLE = '11111111-2222-4333-8444-555555555555';
const allParts = adminCards.flatMap((c) => [...c.parts] as AdminPart[]);
const pagesOf = () => adminSectionList.flatMap((s) => s.tabs.flatMap((t) => t.pages.map((p) => ({ section: s.key, tab: t.key, page: p }))));

describe('the admin sections, tabs and pages (exact set)', () => {
  it('draws Cycle, the five modules AI-HR has, then Email and Reports, in that order and group', () => {
    expect(adminSectionList.map((s) => [s.key, s.group, s.module ?? null])).toEqual([
      ['cycle', 'top', null], ['performance', 'modules', 'pm'], ['feedback', 'modules', 'f360'], ['competency', 'modules', 'competency'],
      ['calibration', 'modules', 'calibration'], ['career', 'modules', 'idp'], ['email', 'end', null], ['reports', 'end', null],
    ]);
  });

  it('gives every section exactly its tabs and every tab exactly its pages', () => {
    expect(Object.fromEntries(adminSectionList.map((s) => [s.key, Object.fromEntries(s.tabs.map((t) => [t.key, t.pages.map((p) => p.key)]))]))).toEqual({
      cycle: { calendar: ['calendar'], participants: ['participants'], release: ['release'], cycles: ['cycles'] },
      performance: { overview: ['overview'], run: ['progress', 'importKpiTargets', 'fillBuKpi'], settings: ['settings'] },
      feedback: { overview: ['overview'], run: ['people', 'raterProgress', 'panels'], settings: ['framework'] },
      competency: { overview: ['overview'], run: ['progress', 'assignCompetencies', 'importJobCodes'], settings: ['competencyLibrary'] },
      calibration: { overview: ['overview'], run: ['progress', 'lockStatus'], settings: ['patAchievement', 'calibrationGroups'] },
      career: { overview: ['overview'], run: ['progress'], settings: ['careerRoutes'] },
      email: { schedule: ['everyonesReminder'] },
      reports: { reports: ['ratingsRecord', 'builtByAgent'] },
    });
  });

  it('gives every module section the same three tabs, Overview · Run · Settings, with the one shared Overview', () => {
    const modules = adminSectionList.filter((s) => s.group === 'modules');
    expect(modules.map((s) => s.module).sort()).toEqual([...overviewModules].sort());
    for (const s of modules) {
      expect(s.tabs.map((t) => t.key), s.key).toEqual(['overview', 'run', 'settings']);
      expect(s.tabs[0].pages, s.key).toEqual([{ key: 'overview', parts: [], extra: 'overview' }]);
    }
    expect(pagesOf().filter((x) => x.page.extra === 'overview').map((x) => x.section)).toEqual(modules.map((s) => s.key));
  });

  it('draws the existing pages at their own addresses: Release results, Ratings record, and the hidden agent report', () => {
    expect(pagesOf().filter((x) => x.page.route).map((x) => [x.section, x.tab, x.page.key, x.page.route, !!x.page.hidden])).toEqual([
      ['cycle', 'release', 'release', 'release', false], ['reports', 'reports', 'ratingsRecord', 'records', false], ['reports', 'reports', 'builtByAgent', 'reports', true],
    ]);
    for (const x of pagesOf().filter((p) => p.page.route)) expect(x.page.parts).toEqual([]);
  });
});

describe('the inventory: every card of the old cycle page lands in exactly one page', () => {
  it('names the cycle page\'s cards in the order it renders them', () => {
    expect(adminCards.map((c) => c.id)).toEqual(['cycleActions', 'policy', 'modules', 'windows', 'participants', 'units', 'progress', 'panels', 'framework', 'catalogue', 'kpiImport', 'companyKpi', 'assessments', 'profit', 'reminders', 'calibration']);
    expect(new Set(allParts).size).toBe(allParts.length);
  });

  it('places each part once, and nothing that is not a part', () => {
    const placed = pagesOf().flatMap((x) => x.page.parts.map((part) => ({ part, at: `${x.section}/${x.tab}/${x.page.key}` })));
    expect(placed.map((x) => x.part).sort()).toEqual([...allParts].sort());
    expect(Object.fromEntries(placed.map((x) => [x.part, x.at]))).toEqual({
      cycleActions: 'cycle/calendar/calendar', policy: 'cycle/calendar/calendar', modules: 'cycle/calendar/calendar', windows: 'cycle/calendar/calendar',
      participants: 'cycle/participants/participants', units: 'cycle/participants/participants',
      'progress.pm': 'performance/run/progress', assessments: 'performance/run/progress', kpiImport: 'performance/run/importKpiTargets', companyKpi: 'performance/run/fillBuKpi',
      'progress.feedback': 'feedback/run/people', 'progress.assessors': 'feedback/run/raterProgress', panels: 'feedback/run/panels', framework: 'feedback/settings/framework',
      'progress.competency': 'competency/run/progress', 'catalogue.generate': 'competency/run/assignCompetencies', 'catalogue.import': 'competency/run/importJobCodes', 'catalogue.profiles': 'competency/settings/competencyLibrary',
      'progress.calibration': 'calibration/run/progress', 'calibration.sessions': 'calibration/run/lockStatus', profit: 'calibration/settings/patAchievement', 'calibration.groups': 'calibration/settings/calibrationGroups',
      'progress.career': 'career/run/progress', 'catalogue.routes': 'career/settings/careerRoutes',
      reminders: 'email/schedule/everyonesReminder',
    });
    for (const part of allParts) expect(adminPartHome(part), part).not.toBeNull();
  });

  it('keeps the policy form whole: one part, on Cycle › Calendar only (DQ-4)', () => {
    expect(adminCards.find((c) => c.id === 'policy')?.parts).toEqual(['policy']);
    expect(pagesOf().filter((x) => x.page.parts.includes('policy')).map((x) => `${x.section}/${x.tab}`)).toEqual(['cycle/calendar']);
    expect(adminPartHome('assessments')).toEqual({ section: 'performance', tab: 'run', page: 'progress' }); // DQ-9
  });
});

describe('addresses', () => {
  it('builds each page\'s address from the registry, and the section entry goes to its first tab', () => {
    expect(adminSectionHref(CYCLE, 'cycle')).toBe(`/performance/${CYCLE}/cycle/calendar`);
    expect(adminSectionHref(CYCLE, 'reports')).toBe(`/performance/${CYCLE}/records`);
    expect(adminPageHref(CYCLE, 'cycle', 'release')).toBe(`/performance/${CYCLE}/release`);
    expect(adminPageHref(CYCLE, 'performance', 'run')).toBe(`/performance/${CYCLE}/performance/run`);
    expect(adminPageHref(CYCLE, 'performance', 'run', 'progress')).toBe(`/performance/${CYCLE}/performance/run`);
    expect(adminPageHref(CYCLE, 'feedback', 'run', 'panels')).toBe(`/performance/${CYCLE}/feedback/run?sub=panels`);
    expect(() => adminPageHref(CYCLE, 'reports', 'reports', 'builtByAgent')).toThrow();
    expect(() => adminPageHref(CYCLE, 'learning', 'overview')).toThrow();
  });

  it('resolves exactly what the registry holds and refuses the rest', () => {
    expect(resolveAdminTab('feedback', 'run', 'raterProgress')?.page.parts).toEqual(['progress.assessors']);
    expect(resolveAdminTab('feedback', 'run', null)?.page.key).toBe('people');
    expect(resolveAdminTab('feedback', 'run', '')?.page.key).toBe('people');
    for (const [section, tab, sub] of [['learning', 'overview', null], ['cycle', 'reminders', null], ['performance', 'run', 'panels'], ['reports', 'reports', 'builtByAgent'], ['Performance', 'run', null], ['performance', 'run', 'progress?x']] as const) {
      expect(resolveAdminTab(section, tab, sub), `${section}/${tab}/${sub}`).toBeNull();
    }
    for (const s of adminSectionList) for (const t of s.tabs) expect(visibleAdminPages(t).length, `${s.key}/${t.key}`).toBeGreaterThan(0);
  });

  it('sends a cycle form back only to this cycle\'s own card pages', () => {
    expect(adminReturnPath(`/performance/${CYCLE}/cycle/calendar`, CYCLE)).toBe(`/performance/${CYCLE}/cycle/calendar`);
    expect(adminReturnPath(`/performance/${CYCLE}/feedback/run?sub=panels`, CYCLE)).toBe(`/performance/${CYCLE}/feedback/run?sub=panels`);
    expect(adminReturnPath(`/performance/${CYCLE}/feedback/run?sub=people`, CYCLE)).toBe(`/performance/${CYCLE}/feedback/run`);
    const other = '99999999-2222-4333-8444-555555555555';
    for (const raw of [
      undefined, null, 42, '', `/performance/${CYCLE}`, `/performance/${other}/cycle/calendar`, `https://evil.example/performance/${CYCLE}/cycle/calendar`,
      `//evil.example/performance/${CYCLE}/cycle/calendar`, `/performance/${CYCLE}/cycle/release`, `/performance/${CYCLE}/cycle/calendar?error=x`,
      `/performance/${CYCLE}/cycle/calendar#policy`, `/performance/${CYCLE}/feedback/run?sub=builtByAgent`, `/performance/${CYCLE}/learning/overview`,
      `/performance/${CYCLE}/cycle/calendar/extra`, `/performance/${CYCLE}/cycle/../../admin`, `/performance/${CYCLE}/${'x'.repeat(400)}`,
    ]) expect(adminReturnPath(raw, CYCLE), String(raw)).toBeNull();
  });
});

describe('when a card shows (the cycle page\'s own conditions, owned once)', () => {
  const policy = defaultPolicy(framework);
  const state = (status: string, over: Partial<AdminCycleState['policy']> = {}, kpiNames = 1): AdminCycleState => ({ status, policy: { kind: policy.kind, modules: policy.modules, ...over }, kpiNames });
  const shown = (s: AdminCycleState) => allParts.filter((p) => adminPartShown(p, s));

  it('draft: the set-up cards only', () => {
    expect(shown(state('draft'))).toEqual(['cycleActions', 'policy', 'units', 'framework', 'catalogue.import', 'catalogue.profiles', 'catalogue.routes', 'catalogue.generate', 'kpiImport', 'assessments', 'profit', 'reminders', 'calibration.sessions']);
  });

  it('open, every module on: every part', () => {
    expect(shown(state('open', { modules: { ...policy.modules, calibration: true } }))).toEqual(allParts);
    expect(shown(state('calibration'))).toEqual(allParts);
  });

  it('closed: nothing that writes into a live cycle', () => {
    expect(shown(state('closed'))).toEqual(['cycleActions', 'policy', 'units', 'progress.pm', 'progress.feedback', 'progress.assessors', 'progress.competency', 'progress.calibration', 'progress.career', 'framework', 'assessments', 'profit', 'reminders', 'calibration.sessions']);
  });

  it('follows the modules, the cycle kind and the KPI names', () => {
    expect(adminPartShown('panels', state('open', { modules: { ...policy.modules, tm: false } }))).toBe(false);
    expect(adminPartShown('kpiImport', state('open', { modules: { ...policy.modules, pm: false } }))).toBe(false);
    expect(adminPartShown('companyKpi', state('open', {}, 0))).toBe(false);
    expect(adminPartShown('companyKpi', state('open', { kind: 'quarterly' }))).toBe(false);
    expect(adminPartShown('profit', state('open', { kind: 'quarterly' }))).toBe(false);
    const noCalibration = state('open', { modules: { ...policy.modules, calibration: false } });
    expect(['profit', 'calibration.sessions', 'calibration.groups'].map((p) => adminPartShown(p as AdminPart, noCalibration))).toEqual([false, false, false]);
    expect(adminPartShown('calibration.groups', state('open', { kind: 'quarterly', modules: { ...policy.modules, tm: false } }))).toBe(false);
    expect(adminPartShown('calibration.groups', state('open', { kind: 'quarterly' }))).toBe(true);
  });

  it('shows a card exactly when one of its parts shows', () => {
    for (const s of [state('draft'), state('open'), state('closed'), state('open', { modules: { ...policy.modules, calibration: false, tm: false } })]) {
      for (const card of adminCards) expect(adminCardShown(card.id, s), `${card.id}@${s.status}`).toBe((card.parts as readonly AdminPart[]).some((p) => adminPartShown(p, s)));
    }
  });
});

describe('the module Overview\'s stages and module facts', () => {
  const policy = defaultPolicy(framework);
  const emitted = (kind: 'year_end' | 'quarterly') => {
    const out = new Map<ProgressModule, Set<string>>(progressModules.map((m) => [m, new Set<string>()]));
    for (const kpis of [[], [{ checkIn: null }], [{ checkIn: { answer: 'on_track' } }]]) for (const resultsSubmitted of [false, true]) for (const performanceConfirmed of [false, true])
      for (const competencyStatus of ['pending', 'submitted', 'reviewed']) for (const competencyCount of [0, 2]) for (const [panelCount, panelSubmitted] of [[0, 0], [3, 1], [3, 3]])
        for (const calibration of ['none', 'draft', 'locked'] as const) for (const planStatus of [null, 'draft', 'shared', 'closed']) {
          const cells = assessmentProgress({ kpis: kpis as never, performanceConfirmed, resultsSubmitted, competencyStatus, competencyCount, panelCount, panelSubmitted, calibration, planStatus, policy: { ...policy, kind, modules: { ...policy.modules, calibration: true } } });
          for (const m of progressModules) if (cells[m]) out.get(m)!.add(cells[m]!.label);
        }
    return out;
  };

  it('lists every label Review progress can give, per module and kind, and nothing else', () => {
    const yearEnd = emitted('year_end'), quarterly = emitted('quarterly');
    for (const m of progressModules) expect([...yearEnd.get(m)!].sort(), m).toEqual([...progressStages(m, 'year_end')].sort());
    expect([...quarterly.get('pm')!].sort()).toEqual([...progressStages('pm', 'quarterly')].sort());
    for (const m of progressModules) for (const label of progressStages(m, 'year_end')) expect(en.onehr.progressAdmin.labels[label as keyof typeof en.onehr.progressAdmin.labels], label).toBeTruthy();
  });

  it('maps each module to its progress module and switch', () => {
    expect(overviewProgressModule).toEqual({ pm: 'pm', f360: 'feedback', competency: 'competency', calibration: 'calibration', idp: 'career' });
    const off = { ...policy.modules, pm: false, tm: false, idp: false, calibration: false };
    expect(overviewModules.map((k) => overviewModuleOn({ modules: off }, k))).toEqual([false, false, false, false, false]);
    expect(overviewModules.map((k) => overviewModuleOn({ modules: { ...off, tm: true } }, k))).toEqual([false, true, true, false, false]);
    expect(overviewModuleOn({ modules: { ...off, calibration: undefined } }, 'calibration')).toBe(true);
  });
});

describe('labels (APR-023) and the route\'s registration', () => {
  it('has a performanceAdmin label for every section, tab and page, in six identical locales', () => {
    const pa = en.performanceAdmin as unknown as { sections: Record<string, string>; tabs: Record<string, string>; pages: Record<string, string> };
    for (const s of adminSectionList) {
      expect(pa.sections[s.key], s.key).toBeTruthy();
      for (const t of s.tabs) { expect(pa.tabs[t.key], t.key).toBeTruthy(); for (const p of t.pages) expect(pa.pages[p.key], p.key).toBeTruthy(); }
    }
    expect(pa.sections).toMatchObject({ cycle: 'Cycle', performance: 'Performance', feedback: '360 Feedback', competency: 'Competency', calibration: 'Calibration & Talent', career: 'Career Plan', email: 'Email', reports: 'Reports' });
    expect(pa.tabs).toMatchObject({ calendar: 'Calendar', participants: 'Participants', release: 'Release results', cycles: 'All cycles', overview: 'Overview', run: 'Run', settings: 'Settings', schedule: 'Schedule' });
    const flat = (o: unknown, prefix = ''): string[] => Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
    const keys = flat(en.performanceAdmin).sort();
    expect(keys.length).toBeGreaterThan(50);
    for (const locale of ['ms', 'ta', 'th', 'vi', 'zh']) {
      const messages = JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${locale}.json`), 'utf8'));
      expect(flat(messages.performanceAdmin).sort(), locale).toEqual(keys);
    }
  });

  it('registers the one new route on the performance screen only, guarded like /performance/[cycleId], with its loading boundary', () => {
    const route = '/performance/[cycleId]/[section]/[tab]';
    expect(SCREENS.filter((s) => s.routes.includes(route)).map((s) => s.screenKey)).toEqual(['performance']);
    expect(SCREENS.find((s) => s.screenKey === 'performance')?.routes).toEqual(expect.arrayContaining(['/performance/[cycleId]', '/performance/[cycleId]/release', '/performance/[cycleId]/records', '/performance/[cycleId]/reports', route]));
    const dir = path.join(ROOT, 'app/(app)/performance/[cycleId]/[section]/[tab]');
    const page = fs.readFileSync(path.join(dir, 'page.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    expect(page).toMatch(/const s = await requireOnehrAdminAccess\(\);/);
    expect(page).toMatch(/if \(isOnehrOnlyPerformanceAdmin\(s\) && !await isOnehrAdminCycle\(s, cycleId\)\) notFound\(\);/);
    expect(fs.readFileSync(path.join(dir, 'loading.tsx'), 'utf8').trim()).toBe("export { default } from '@/components/route-loading';");
    // The section folder holds no page of its own, so it needs no boundary; the three existing pages keep theirs.
    expect(fs.existsSync(path.join(ROOT, 'app/(app)/performance/[cycleId]/[section]/page.tsx'))).toBe(false);
    for (const existing of ['release', 'records', 'reports']) expect(fs.existsSync(path.join(ROOT, `app/(app)/performance/[cycleId]/${existing}/loading.tsx`)), existing).toBe(true);
  });

  it('keeps every section and tab slug clear of the existing static segments under /performance/[cycleId]', () => {
    const statics = fs.readdirSync(path.join(ROOT, 'app/(app)/performance/[cycleId]'), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('[')).map((e) => e.name).sort();
    expect(statics).toEqual(['progress', 'records', 'release', 'reports']);
    // A card section slug that equals a static folder would never be reached; Reports is drawn through its existing pages.
    for (const s of adminSectionList.filter((x) => x.tabs.some((t) => t.pages.some((p) => !p.route)))) expect(statics, s.key).not.toContain(s.key);
  });
});
