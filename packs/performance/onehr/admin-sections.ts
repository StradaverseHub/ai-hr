import { ratedPerformance, type Policy } from './model';
import type { OverviewModule } from './overview-model';

/**
 * D-P1-32 PT-X4 (APR-025 D5) — ONE registry for the performance admin area, in the shape of OneHR's
 * `ADMIN_SECTIONS`: a SECTION is an entry in the area's left list, its TABS run across the top, and a tab that
 * holds more than one page lists them in a row under the tabs (`?sub=` picks one; the first page is the tab's
 * own address). Every module section has the same three tabs, Overview · Run · Settings (P1-05 §7.3).
 *
 * The cards are today's cycle page (`app/(app)/performance/onehr/cycle-view.tsx`), in the order it renders them. A card
 * is one or more PARTS, and every part lands in exactly one page here (test/performance-admin-sections.test.ts).
 * Nothing is added or removed: the old page still renders every card whole (D8). A page may instead name an
 * existing route (`route`), which keeps its own address and is drawn inside the same area.
 *
 * Pure data and predicates only; app/(app)/performance/onehr/admin-cards.tsx renders the parts.
 */
export const adminCards = [
  { id: 'cycleActions', parts: ['cycleActions'] },
  { id: 'policy', parts: ['policy'] },
  { id: 'modules', parts: ['modules'] },
  { id: 'windows', parts: ['windows'] },
  { id: 'participants', parts: ['participants'] },
  { id: 'units', parts: ['units'] },
  // One Review progress card with a module filter today; each module's Run tab holds its own fixed instance.
  { id: 'progress', parts: ['progress.pm', 'progress.feedback', 'progress.assessors', 'progress.competency', 'progress.calibration', 'progress.career'] },
  { id: 'panels', parts: ['panels'] },
  { id: 'framework', parts: ['framework'] },
  // Each section of the competency architecture card posts its own action, so it splits safely (X0 §2.1 row 12).
  { id: 'catalogue', parts: ['catalogue.import', 'catalogue.profiles', 'catalogue.routes', 'catalogue.generate'] },
  { id: 'kpiImport', parts: ['kpiImport'] },
  { id: 'companyKpi', parts: ['companyKpi'] },
  { id: 'assessments', parts: ['assessments'] },
  { id: 'profit', parts: ['profit'] },
  { id: 'reminders', parts: ['reminders'] },
  // The calibration card: the session list (lock status, with each group session's final bands) and the
  // scope generation plus the assign form (calibration groups).
  { id: 'calibration', parts: ['calibration.sessions', 'calibration.groups'] },
] as const;

export type AdminCardId = (typeof adminCards)[number]['id'];
export type AdminPart = (typeof adminCards)[number]['parts'][number];
/** Content a page draws that is not one of the cycle page's cards. */
export type AdminExtra = 'overview' | 'allCycles' | 'policyPointer';
/** An existing route under /performance/[cycleId] that a page stands for (it keeps its own address, D8). */
export type AdminRoute = 'release' | 'records' | 'reports';
export type AdminPage = { readonly key: string; readonly parts: readonly AdminPart[]; readonly extra?: AdminExtra; readonly route?: AdminRoute; readonly hidden?: boolean };
export type AdminTab = { readonly key: string; readonly pages: readonly AdminPage[] };
export type AdminSection = { readonly key: string; readonly group: 'top' | 'modules' | 'end'; readonly module?: OverviewModule; readonly tabs: readonly AdminTab[] };

const overview = { key: 'overview', pages: [{ key: 'overview', parts: [], extra: 'overview' }] } as const;

export const adminSections = [
  { key: 'cycle', group: 'top', tabs: [
    { key: 'calendar', pages: [{ key: 'calendar', parts: ['cycleActions', 'policy', 'modules', 'windows'] }] },
    { key: 'participants', pages: [{ key: 'participants', parts: ['participants', 'units'] }] },
    { key: 'release', pages: [{ key: 'release', parts: [], route: 'release' }] },
    { key: 'cycles', pages: [{ key: 'cycles', parts: [], extra: 'allCycles' }] },
  ] },
  { key: 'performance', group: 'modules', module: 'pm', tabs: [
    overview,
    { key: 'run', pages: [
      { key: 'progress', parts: ['progress.pm', 'assessments'] },
      { key: 'importKpiTargets', parts: ['kpiImport'] },
      { key: 'fillBuKpi', parts: ['companyKpi'] },
    ] },
    // DQ-4: the policy form stays whole on Cycle › Calendar, so this tab points there.
    { key: 'settings', pages: [{ key: 'settings', parts: [], extra: 'policyPointer' }] },
  ] },
  { key: 'feedback', group: 'modules', module: 'f360', tabs: [
    overview,
    { key: 'run', pages: [
      { key: 'people', parts: ['progress.feedback'] },
      { key: 'raterProgress', parts: ['progress.assessors'] },
      { key: 'panels', parts: ['panels'] },
    ] },
    { key: 'settings', pages: [{ key: 'framework', parts: ['framework'] }] },
  ] },
  { key: 'competency', group: 'modules', module: 'competency', tabs: [
    overview,
    { key: 'run', pages: [
      { key: 'progress', parts: ['progress.competency'] },
      { key: 'assignCompetencies', parts: ['catalogue.generate'] },
      { key: 'importJobCodes', parts: ['catalogue.import'] },
    ] },
    { key: 'settings', pages: [{ key: 'competencyLibrary', parts: ['catalogue.profiles'] }] },
  ] },
  { key: 'calibration', group: 'modules', module: 'calibration', tabs: [
    overview,
    { key: 'run', pages: [
      { key: 'progress', parts: ['progress.calibration'] },
      { key: 'lockStatus', parts: ['calibration.sessions'] },
    ] },
    { key: 'settings', pages: [
      { key: 'patAchievement', parts: ['profit'] },
      { key: 'calibrationGroups', parts: ['calibration.groups'] },
    ] },
  ] },
  { key: 'career', group: 'modules', module: 'idp', tabs: [
    overview,
    { key: 'run', pages: [{ key: 'progress', parts: ['progress.career'] }] },
    { key: 'settings', pages: [{ key: 'careerRoutes', parts: ['catalogue.routes'] }] },
  ] },
  // DQ-10: OneHR's Email and Reports sections, drawn only with what AI-HR already has.
  { key: 'email', group: 'end', tabs: [
    { key: 'schedule', pages: [{ key: 'everyonesReminder', parts: ['reminders'] }] },
  ] },
  { key: 'reports', group: 'end', tabs: [
    { key: 'reports', pages: [
      { key: 'ratingsRecord', parts: [], route: 'records' },
      // The assistant's report page needs its report's own query, so it has no link of its own (OneHR: hidden).
      { key: 'builtByAgent', parts: [], route: 'reports', hidden: true },
    ] },
  ] },
] as const satisfies readonly AdminSection[];

export type AdminSectionKey = (typeof adminSections)[number]['key'];
/** The registry as plain section records, for iterating without the literal types. */
export const adminSectionList: readonly AdminSection[] = adminSections;

export function adminSection(key: string): AdminSection | undefined {
  return adminSectionList.find((s) => s.key === key);
}

/** The pages a tab lists (hidden pages belong to the tab without a link of their own). */
export function visibleAdminPages(tab: AdminTab): readonly AdminPage[] {
  return tab.pages.filter((p) => !p.hidden);
}

/**
 * The section, tab and page an admin address names, or null for anything the registry does not hold. `sub` is
 * the `?sub=` query; absent or empty picks the tab's first page. A hidden page is never addressable this way.
 */
export function resolveAdminTab(section: string, tab: string, sub?: string | null): { section: AdminSection; tab: AdminTab; page: AdminPage } | null {
  const s = adminSection(section), t = s?.tabs.find((x) => x.key === tab);
  if (!s || !t) return null;
  const pages = visibleAdminPages(t), page = sub ? pages.find((p) => p.key === sub) : pages[0];
  return page ? { section: s, tab: t, page } : null;
}

/** The address of one page: its existing route, or the tab's address (with `?sub=` for any page after the first). */
export function adminPageHref(cycleId: string, section: string, tab: string, page?: string): string {
  const s = adminSection(section), t = s?.tabs.find((x) => x.key === tab);
  if (!s || !t) throw Error(`Unknown admin tab ${section}/${tab}.`);
  const pages = visibleAdminPages(t), p = page ? pages.find((x) => x.key === page) : pages[0];
  if (!p) throw Error(`Unknown admin page ${section}/${tab}/${page}.`);
  if (p.route) return `/performance/${cycleId}/${p.route}`;
  const base = `/performance/${cycleId}/${s.key}/${t.key}`;
  return pages.indexOf(p) > 0 ? `${base}?sub=${p.key}` : base;
}

/** The first tab's address: where a section entry in the left list goes. */
export function adminSectionHref(cycleId: string, section: string): string {
  const s = adminSection(section);
  if (!s) throw Error(`Unknown admin section ${section}.`);
  return adminPageHref(cycleId, s.key, s.tabs[0].key);
}

/** Where a part lives: the first section › tab › page that holds it (the inventory test proves it is the only one). */
export function adminPartHome(part: AdminPart): { section: string; tab: string; page: string } | null {
  for (const s of adminSectionList) for (const t of s.tabs) for (const p of t.pages) if (p.parts.includes(part)) return { section: s.key, tab: t.key, page: p.key };
  return null;
}

/** What decides whether a card shows: the cycle's status, its policy, and whether any KPI names exist yet. */
export type AdminCycleState = { status: string; policy: Pick<Policy, 'modules' | 'kind'>; kpiNames: number };
const live = (s: AdminCycleState) => s.status === 'open' || s.status === 'calibration';

/**
 * Whether a part renders for this cycle: the conditions the cycle page has always applied to each card, owned
 * here once so the old page and the admin tabs cannot disagree.
 */
export function adminPartShown(part: AdminPart, s: AdminCycleState): boolean {
  const p = s.policy, calibration = p.modules.calibration !== false;
  switch (part) {
    case 'cycleActions': case 'policy': case 'units': case 'framework': case 'assessments': case 'reminders': return true;
    case 'modules': case 'windows': case 'participants': return live(s);
    case 'progress.pm': case 'progress.feedback': case 'progress.assessors': case 'progress.competency': case 'progress.calibration': case 'progress.career': return s.status !== 'draft';
    case 'panels': return live(s) && p.modules.tm;
    case 'catalogue.import': case 'catalogue.profiles': case 'catalogue.routes': case 'catalogue.generate': return s.status !== 'closed';
    case 'kpiImport': return s.status !== 'closed' && p.modules.pm;
    case 'companyKpi': return live(s) && ratedPerformance(p) && s.kpiNames > 0;
    case 'profit': return ratedPerformance(p) && calibration;
    case 'calibration.sessions': return calibration;
    case 'calibration.groups': return calibration && live(s) && (ratedPerformance(p) || p.modules.tm);
  }
}

/** A card shows when any of its parts does (each card's parts share its outer condition). */
export function adminCardShown(card: AdminCardId, s: AdminCycleState): boolean {
  const found = adminCards.find((c) => c.id === card);
  return !!found && (found.parts as readonly AdminPart[]).some((part) => adminPartShown(part, s));
}

/**
 * The admin page a cycle form came from, rebuilt from the registry, or null. Accepts only this cycle's own tab
 * addresses (`/performance/<cycleId>/<section>/<tab>` with an optional `?sub=`) that the registry draws as card
 * pages; anything else (another cycle, an existing route, a stray query, an absolute URL) is refused, so a form
 * can never send a save to an arbitrary address.
 */
export function adminReturnPath(raw: unknown, cycleId: string): string | null {
  if (typeof raw !== 'string' || raw.length > 300 || !raw.startsWith(`/performance/${cycleId}/`)) return null;
  let url: URL;
  try { url = new URL(raw, 'https://local.invalid'); } catch { return null; }
  if (url.origin !== 'https://local.invalid' || url.hash) return null;
  const match = /^\/performance\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!match || match[1] !== cycleId || [...url.searchParams.keys()].some((k) => k !== 'sub')) return null;
  const at = resolveAdminTab(match[2], match[3], url.searchParams.get('sub'));
  if (!at || at.page.route) return null;
  return adminPageHref(cycleId, at.section.key, at.tab.key, at.page.key);
}
