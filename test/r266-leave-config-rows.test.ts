/** r378: consolidated Import row and guarded bookmark aliases supersede the historical importer layout below. */
/**
 * r266 · 10b59703 — THE LEFT SUBMENU IS THE ONLY NAVIGATION BETWEEN LEAVE CONFIG SCREENS.
 *
 * What the reporter measured on 11 September: the Entitlements row opened a page headed "Leave types"
 * with fourteen navigation controls before the content (four header links, an Import button, nine pills
 * repeated on every Leave Config screen), two screens named twice on one page, three headings that
 * disagreed with the row that opened them, and two pages sharing the Leave types sentence as their
 * description. The plan's answer, pinned here:
 *
 *   §A  the map is grouped by the five submenu rows (agreement with LEAVE_ADMIN_NAV, both ways);
 *   §B  NO Leave Config page renders the nine-screen pill row: the component renders only the current
 *       row's tabs, has no group captions, and renders nothing for a single-screen row;
 *   §C  every page's heading is its ROW's `nav.*` label, read through one helper, and the row's
 *       description is one sentence per row, none of them the Leave types sentence;
 *   §D  the moves: header links gone, Run earned accrual on Generate, pointers left behind, eligibility
 *       rules still under Entitlements (Company rules only points), routes unchanged;
 *   §E  the six-locale strings this item minted or renamed.
 *
 * NON-VACUITY: restore the all-groups render in a copy of components/leave-config-map.tsx (the pill
 * row) and §B's "renders only the current row" case fails; put one of the four header links back on
 * types/page.tsx and §D's header case fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

// m4 — a REAL translator over the English catalogue, so `leaveConfigPageHeader` can be exercised rather than
// grepped: breaking it (title → the tab label) left every source-shape case green.
vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => (key: string) => {
    const node = `${ns}.${key}`
      .split('.')
      .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);
    if (typeof node !== 'string') throw new Error(`MISSING_MESSAGE: ${ns}.${key}`);
    return node;
  },
}));

import {
  LEAVE_CONFIG_MAP,
  LEAVE_CONFIG_RECORDS_HREF,
  leaveConfigGroupOf,
  leaveConfigPageHeader,
  type MappedLeaveConfigScreenId,
} from '../components/leave-config-map';
import { leavePack } from '../packs/leave';
import { REGISTERED_ROUTES, SCREENS } from '../lib/permissions';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');
const CATALOGUES = { en, ms, ta, th, vi: vi_, zh } as const;
type Dict = Record<string, unknown>;
const getPath = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);

/** Every page of the module, walked from disk so a page added later cannot skip this. */
function pages(dir = 'app/admin/leave-config', out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) pages(p, out);
    else if (e.name === 'page.tsx') out.push(p);
  }
  return out;
}
/**
 * 7f69bd71 — three files under the module are NOT row pages and are named here rather than tolerated:
 * the Reset records SUB-SCREEN (its own heading and a back link, no tab row — a sub-screen of the Leave
 * Adjustments row reached from a link, the r265 Shift-arrangement shape) and the two redirect STUBS the
 * old tab addresses became. Each is asserted to be what it claims below, so a row page cannot hide in
 * this list, and everything else on disk is still held to the heading-equals-row rule.
 */
const SUB_SCREEN = 'app/admin/leave-config/records/page.tsx';
const STUBS = ['app/admin/leave-config/records/entitlement/page.tsx', 'app/admin/leave-config/records/balances/page.tsx'];
/**
 * r279 (3fbf7a02) — LEAVE BALANCE HEALTH IS NOT ON THIS EXCLUSION LIST, and it was the round's decision
 * that it should not be. It is a new page under the module, so it takes a map group of its own (of one
 * item, drawing no tab row) and reads its header through `leaveConfigPageHeader` like every other row
 * page — which means §B's "every page mounts the map exactly once" and §C's "every page reads its
 * header through the row helper" cover it on arrival, with nothing added here. The alternative, a page
 * with no group, would have needed its own carve-out in both of those loops AND in
 * test/leave-config-map.test.ts: three exceptions bought nothing that one map entry did not.
 */
// r378: importer bookmarks are guarded redirects, not duplicate row pages.
const IMPORT_ALIASES = {
  'app/admin/leave-config/history-import/page.tsx': 'history',
  'app/admin/leave-config/bf-import/page.tsx': 'bf',
} as const;
const PAGES = pages().filter((p) => p !== SUB_SCREEN && !STUBS.includes(p) && !(p in IMPORT_ALIASES));
const MAP_SRC = read('components/leave-config-map.tsx');
const MAP_CODE = stripComments(MAP_SRC);
const CHILDREN = leavePack.navNodes!.find((n) => n.group === 'admin')!.children;
/**
 * 5ca446db (r269) — the five CONFIGURATION rows, which is what this file has always been about.
 *
 * The fly-out gained a sixth child (Employee Leave Inquiry → `/leave/employee-balances`) that is not a
 * Leave Config screen: no page under `app/admin/leave-config/**`, its own `leaveEmployeeBalances`
 * permission column, its own PageHeader. Every case below that reasons about "the rows and their tabs"
 * means these five; the sixth has its own case in §A and in test/leave-flyout-nav.test.ts.
 */
/**
 * r279 (3fbf7a02) — SIX now, not five, and the FILTER IS UNCHANGED. Leave Balance Health joined as a row
 * and as a map group in the same commit, so "the rows whose destinations live under the module" still
 * describes exactly the groups of LEAVE_CONFIG_MAP, one for one, in order.
 */
const ROWS = CHILDREN.filter((c) => c.href.startsWith('/admin/leave-config/'));

describe('§A · the map is the submenu rows, in the submenu\'s order', () => {
  it('group ↔ row agreement, both directions, first item = the row\'s own href', () => {
    expect(LEAVE_CONFIG_MAP.map((g) => g.navKey)).toEqual(ROWS.map((r) => r.labelKey));
    expect(LEAVE_CONFIG_MAP.map((g) => g.items[0].href)).toEqual(ROWS.map((r) => r.href));
    // r279 — six, because Balance Health is a row AND a group. An exact count, not a floor: a row added
    // without a group (or a group without a row) fails the two `toEqual`s above before reaching this.
    // r281 — SEVEN: Run earned accrual took a row and a group in the same commit, exactly as Balance
    // Health did, so the two lists moved together and no exception was needed anywhere in this file.
    // r281 (a73d1e14) — EIGHT: Special Setting took a row and a group in the same commit too.
    // 3fb1a611 (r299) — NINE: Leave Credit took a row and a group in the same commit, like each before it.
    // 3f15ffdb (r362) — TEN: Leave History Data Import took a row and a group in the same commit too, so
    // the two `toEqual`s above moved together and no exception was needed anywhere in this file. It is a
    // group of ONE — a third tab of Leave Adjustments would have inherited that row's "change a balance"
    // heading, which is exactly what an importer that moves no balance must not be read as doing.
    // db55d08a (r369) — ELEVEN, and UPDATED NOT LOOSENED: the old claim read `expect(ROWS).toHaveLength(10)`.
    // Leave B/F Data Import took a row and a group in the same commit, like every row before it, so the two
    // `toEqual`s above moved together and no exception was needed anywhere in this file. It is a group of
    // ONE for a sharper version of the same reason: a tab of Leave History Data Import would have inherited
    // that row's "load past leave records" description, and this tool creates no leave record at all.
    // r378 consolidates the two import rows into one.
    expect(ROWS).toHaveLength(10);
  });

  it('5ca446db — the Leave Inquiry door is the only child with no map group, and it is where r269 put it', () => {
    // UPDATED, NOT LOOSENED: `expect(ROWS).toHaveLength(6)` above still holds exactly, because ROWS is
    // the rows whose destinations live under the module. The extra child is pinned here rather than
    // excluded quietly — a second mapless row would fail the last assertion in this case.
    //
    // r279 (3fbf7a02) — STILL ONE ENTRY. Leave Balance Health is a Leave Config page, so it took a map
    // group rather than joining this list; that is exactly why this case did not have to grow.
    const mapless = CHILDREN.filter((c) => !ROWS.includes(c));
    expect(mapless.map((c) => ({ href: c.href, labelKey: c.labelKey }))).toEqual([
      { href: '/leave/employee-balances', labelKey: 'employeeLeaveInquiry' },
    ]);
    // r269 asked for it "at the bottom, after Company rules", and it is still IMMEDIATELY after Company
    // rules — the position the reporter asked for, pinned as the PAIR rather than as "last".
    //
    // r281 (a73d1e14) — UPDATED, NOT LOOSENED. `CHILDREN.at(-1)` used to be this row and is now Special
    // Setting, because THAT is where the reporter drew the new row: below the inquiry row, at the very
    // bottom. "Last" was never this row's property — "immediately after Company rules" was — so the
    // spelling follows the property rather than the index, and both neighbours are pinned.
    expect(CHILDREN.map((c) => c.labelKey).slice(-3)).toEqual([
      'leaveCompanyRules',
      'employeeLeaveInquiry',
      'leaveSpecialSetting',
    ]);
    // Its route is registered, unmoved, and on its OWN column — not on leaveConfig.
    expect(REGISTERED_ROUTES.has('/leave/employee-balances')).toBe(true);
    expect(SCREENS.find((s) => s.screenKey === 'leaveConfig')!.routes).not.toContain('/leave/employee-balances');
    const own = SCREENS.find((s) => s.screenKey === 'leaveEmployeeBalances')!;
    expect(own.routes).toEqual(['/leave/employee-balances']);
    expect(own.guard).toBe('scopedAdmin');
    // …and the matrix column keeps its OWN name: the row is the area, the column is the screen.
    expect(own.labelKey).toBe('admin.users.screen.leaveEmployeeBalances');
    expect(en.nav.employeeLeaveInquiry).toBe('Employee Leave Inquiry');
  });

  it('every leaveConfig route is on exactly one row, and no route moved (bookmarks keep working)', () => {
    const leaveConfig = SCREENS.find((s) => s.screenKey === 'leaveConfig')!;
    const onMap = LEAVE_CONFIG_MAP.flatMap((g) => g.items.map((i) => i.href));
    // 7f69bd71 — ONE named route is reached from a LINK rather than a tab: the Reset records sub-screen.
    // It is on the key (guarded page), on no row, and linked from Adjust balances. The two tab addresses
    // it replaced are stubs and off the key. Every other route is on exactly one row, as before.
    //
    // r279 (3fbf7a02) — STILL ONE named exception. Balance Health took a map group, so it is on exactly
    // one row like every other route, and this loop needed no second exemption.
    expect(LEAVE_CONFIG_RECORDS_HREF).toBe('/admin/leave-config/records');
    for (const r of leaveConfig.routes) {
      expect(onMap.filter((h) => h === r), r).toHaveLength(r === LEAVE_CONFIG_RECORDS_HREF || Object.keys(IMPORT_ALIASES).some((p) => p.replace(/^app/, '').replace(/\/page\.tsx$/, '') === r) ? 0 : 1);
    }
    expect(leaveConfig.routes).toContain(LEAVE_CONFIG_RECORDS_HREF);
    expect(read('app/admin/leave-config/adjustments/page.tsx')).toContain('<Link href={LEAVE_CONFIG_RECORDS_HREF}');
    expect(onMap).toEqual([
      '/admin/leave-config/types',
      '/admin/leave-config/entitlement-tables',
      // r279 — its row is second, so its screen is second on the flattened map.
      '/admin/leave-config/balance-health',
      '/admin/leave-config/adjustments',
      '/admin/leave-config/import',
      // r378 canonical importer; guarded aliases are verified separately below.
      '/admin/leave-config/data-import',
      '/admin/leave-config/leave-credit',
      '/admin/leave-config/leave-credit/rules',
      '/admin/leave-config/generate',
      // r281 — its row is directly after Generate Entitlement, so its screen is directly after it here.
      '/admin/leave-config/earned-accrual',
      '/admin/leave-config/approval-chains',
      '/admin/leave-config/company-rules',
      // r281 — its ROW is last (after the inquiry row, where the reporter drew it), so its screen is last
      // among the rows whose destinations live under the module.
      '/admin/leave-config/special-setting',
    ]);
  });

  it('7f69bd71 — the three named non-row files are what they claim: a sub-screen with a back link, and two redirect stubs', () => {
    expect(PAGES.length).toBeGreaterThan(0);
    for (const [rel, type] of Object.entries(IMPORT_ALIASES)) {
      const alias = stripComments(read(rel));
      const guard = alias.indexOf('await requireAdmin()');
      const redirect = alias.indexOf(`redirect('/admin/leave-config/data-import?type=${type}')`);
      expect(guard, `${rel} retains authorization`).toBeGreaterThan(-1);
      expect(redirect, `${rel} redirects after its guard`).toBeGreaterThan(guard);
      expect(alias).not.toContain('<LeaveConfigMap');
    }
    const sub = read(SUB_SCREEN);
    expect(sub).toContain('requireAdmin()');
    expect(sub).not.toContain('<LeaveConfigMap');
    expect(sub).not.toContain('leaveConfigPageHeader(');
    expect(sub).toContain("back={{ href: leaveConfigScreenHref('adjustments'), label: tNav('leaveAdjustments') }}");
    for (const rel of STUBS) {
      const s = read(rel);
      expect(s, `${rel} is a redirect stub`).toContain('redirect(`/admin/leave-config/records${qs ? `?${qs}` : \'\'}`)');
      expect(/requireAdmin|scopedAdmin|scopedSession/.test(s), `${rel} carries no guard`).toBe(false);
      expect(s).not.toContain('<LeaveConfigMap');
    }
  });

});

describe('§B · no Leave Config page renders the nine-screen pill row', () => {
  it('the component renders only the CURRENT row\'s tabs, and nothing for a single-screen row', () => {
    const render = MAP_CODE.slice(MAP_CODE.indexOf('export async function LeaveConfigMap('));
    // The render reads ONE group — the current screen's — never the whole list.
    expect(render).toContain('const group = leaveConfigGroupOf(current);');
    expect(render).toContain('if (group.items.length < 2) return null;');
    expect(render).toContain('{group.items.map((it, i) => (');
    expect(render).not.toContain('LEAVE_CONFIG_MAP.map(');
    // The group captions (Configure · Run · History) are gone with the groups they captioned.
    expect(MAP_CODE).not.toContain('t(`group.${');
    expect(getPath(en, 'admin.leaveConfigMap.group')).toBeUndefined();
    // One tab is current, not a link; the rest are plain links to the row's other tabs.
    expect(render).toContain('aria-current="page"');
    expect(render).toContain('<Link href={it.href}');
  });

  it('every page mounts the map exactly once with its own id, and the id\'s group is the page\'s row', () => {
    for (const rel of PAGES) {
      const src = read(rel);
      const mounts = [...src.matchAll(/<LeaveConfigMap current="([a-zA-Z]+)" \/>/g)];
      expect(mounts, `${rel} must mount the tab row exactly once`).toHaveLength(1);
      const id = mounts[0][1] as MappedLeaveConfigScreenId;
      const own = rel.replace(/^app/, '').replace(/\/page\.tsx$/, '');
      expect(leaveConfigGroupOf(id).items.map((i) => i.href), `${rel} mounts a tab of another row`).toContain(own);
      // …and it is the only thing that looks like a strip: no second <nav> of leave-config links.
      expect((src.match(/<nav /g) ?? []).length, `${rel} renders a second navigation strip`).toBe(0);
    }
  });

  it('the rows with tabs are exactly Entitlements and Leave Adjustments, two each', () => {
    // 7f69bd71 — two, not three: the Configuration record and the Balance record left their rows for
    // the Reset records sub-screen (test/reset-records-screen.test.ts).
    const withTabs = LEAVE_CONFIG_MAP.filter((g) => g.items.length > 1).map((g) => [g.id, g.items.length]);
    // 3fb1a611 (r299) — UPDATED, NOT LOOSENED: Leave Credit is the third row with tabs (Credits · Rules), each
    // its own route, drawn by the map like the two above — so no page draws a strip of its own.
    // 3f15ffdb (r362) — STILL THREE, and that is the assertion doing its job rather than a gap in it:
    // Leave History Data Import took a group of ONE, so it draws no strip and this list did not grow.
    // Had it been built as a third tab of `adjustments` that entry would read `['adjustments', 3]` here.
    expect(withTabs).toEqual([
      ['entitlements', 2],
      ['adjustments', 2],
      ['leaveCredit', 2],
    ]);
  });
});

describe('§C · every page\'s heading is its submenu row, and its description is the row\'s', () => {
  it('m4 — leaveConfigPageHeader(id) resolves, for all seven ids, to the ROW\'s nav label and the row\'s description', async () => {
    // 7f69bd71 — seven, not nine: the two record ids have no row any more (they label the sub-tabs of the
    // Reset records sub-screen and are excluded from MappedLeaveConfigScreenId by type).
    // r279 (3fbf7a02) — eight: `balanceHealth` is the one screen of its own row, and it resolves through
    // this helper exactly like every other, which is the whole reason it was given a group.
    const ids = LEAVE_CONFIG_MAP.flatMap((g) => g.items.map((i) => i.id as MappedLeaveConfigScreenId));
    // r281 (09386e29) — nine: `earnedAccrual` is the one screen of its own row and resolves through
      // this helper exactly like every other, which is the whole reason it was given a group.
      // r281 (a73d1e14) — ten, with `specialSetting`.
      // 3fb1a611 (r299) — twelve, with Leave Credit's two tabs.
      // 3f15ffdb (r362) — THIRTEEN, with `leaveHistoryImport`: the one screen of its own row, resolving
      // through this helper exactly like every other, which is the whole reason it was given a group.
      // db55d08a (r369) — FOURTEEN, with `leaveBfImport`. UPDATED, NOT LOOSENED: the old claim read
      // `expect(ids).toHaveLength(13)`.
      // r378 one canonical import id replaces two row ids.
      expect(ids).toHaveLength(13);
    for (const id of ids) {
      const group = leaveConfigGroupOf(id);
      const header = await leaveConfigPageHeader(id);
      expect(header.title, id).toBe(getPath(en, `nav.${group.navKey}`));
      // …and never the tab label, which is the mismatch the reporter measured.
      if (getPath(en, `admin.leaveConfigMap.item.${id}`) !== header.title)
        expect(header.title, id).not.toBe(getPath(en, `admin.leaveConfigMap.item.${id}`));
      expect(header.description.length, id).toBeGreaterThan(0);
    }
    // The two tabs of a row share one heading and one description.
    const ent = await Promise.all((['leaveTypes', 'entitlementTables'] as const).map(leaveConfigPageHeader));
    expect(new Set(ent.map((h) => `${h.title}|${h.description}`)).size).toBe(1);
    expect(ent[0].title).toBe('Entitlements');
    const adj = await Promise.all((['adjustments', 'importLeaveData'] as const).map(leaveConfigPageHeader));
    expect(new Set(adj.map((h) => `${h.title}|${h.description}`)).size).toBe(1);
    expect(adj[0].title).toBe('Leave Adjustments');
    expect((await leaveConfigPageHeader('approvalChain')).title).toBe('Approval Workflow');
  });

  it('each page reads its PageHeader through leaveConfigPageHeader(<its own id>)', () => {
    for (const rel of PAGES) {
      const src = read(rel);
      const mount = src.match(/<LeaveConfigMap current="([a-zA-Z]+)" \/>/);
      expect(mount, `${rel} has a real map mount`).not.toBeNull();
      const id = mount![1];
      expect(src, `${rel} must read its header through the row helper`).toContain(`leaveConfigPageHeader('${id}')`);
      // No page titles itself with the TAB label any more: that is the heading/row mismatch measured.
      const headerBlock = src.slice(src.indexOf('<PageHeader'), src.indexOf('/>', src.indexOf('<PageHeader')));
      expect(headerBlock, `${rel} titles itself with the tab label`).not.toContain('leaveConfigScreenTitle(');
    }
  });

  it('the helper maps every row to its nav key and to one description key, and the nav keys are the sidebar\'s', () => {
    for (const g of LEAVE_CONFIG_MAP) {
      for (const [loc, cat] of Object.entries(CATALOGUES)) {
        expect(typeof getPath(cat, `nav.${g.navKey}`), `${loc} nav.${g.navKey}`).toBe('string');
      }
    }
    const descriptionKeys: Record<string, string> = {
      entitlements: 'admin.leaveConfigTypes.rowDescription',
      // r279 (3fbf7a02) — its own namespace, the house shape (`admin.leaveConfig<Row>.pageDescription`),
      // so the row that answers "can this leave type produce a balance" describes itself in its own words
      // rather than borrowing the Entitlements sentence.
      balanceHealth: 'admin.leaveConfigBalanceHealth.pageDescription',
      adjustments: 'admin.leaveConfigAdjustments.pageDescription',
      // 3f15ffdb (r362) — its own namespace, the house shape. It must NOT borrow the Leave Adjustments
      // sentence ("Change an employee's balance by hand… and load balances from a file"): that row is
      // about changing balances and this one changes none, so sharing the sentence would tell an
      // administrator the opposite of what the tool does.
      leaveDataImport: 'admin.leaveDataImport.pageDescription',
      // db55d08a (r369) — its own namespace, the house shape. It must NOT borrow EITHER neighbour's
      // sentence, and the two failures would read differently: Leave History Data Import's sentence says
      // this loads past leave records (it creates none at all), and Leave Adjustments' says it changes a
      // balance by hand (it states the figure a leave year OPENS with, which is a different act).
      leaveBfImport: 'admin.leaveConfigBfImport.pageDescription',
      // 3fb1a611 (r299) — its own namespace, the house shape.
      leaveCredit: 'admin.leaveConfigLeaveCredit.pageDescription',
      generate: 'admin.leaveConfigGenerate.pageDescription',
        // r281 (09386e29) — its own namespace, the house shape (`admin.leaveConfig<Row>.pageDescription`),
        // so the row that TOPS UP earned entitlement describes itself in its own words instead of
        // borrowing the sentence belonging to the row that CREATES entitlement — which is exactly the
        // confusion this item exists to end.
        earnedAccrual: 'admin.leaveConfigEarnedAccrual.pageDescription',
      approval: 'admin.leaveConfigApprovalChains.pageDescription',
      companyRules: 'admin.leaveConfigCompanyRules.pageDescription',
        // r281 (a73d1e14) — its own namespace, the house shape. The row describes the CATEGORY ("settings
        // that apply across every leave type"), not the one setting on it today, so a second special
        // setting joining the group needs no reworded sentence.
        specialSetting: 'admin.leaveConfigSpecialSetting.pageDescription',
    };
    for (const [group, key] of Object.entries(descriptionKeys)) {
      const [ns, leaf] = [key.slice(0, key.lastIndexOf('.')), key.slice(key.lastIndexOf('.') + 1)];
      expect(MAP_CODE, `${group} description key`).toContain(`${group}: ['${ns}', '${leaf}']`);
      for (const [loc, cat] of Object.entries(CATALOGUES)) {
        const v = getPath(cat, key);
        expect(typeof v, `${loc} ${key}`).toBe('string');
        // m5 — the Leave types sentence both pages borrowed (`admin.leave.pageDescription`) had no reader
        // left, so it is pruned rather than kept as an orphan a copy-paste could revive.
        expect(getPath(cat, 'admin.leave.pageDescription'), `${loc} admin.leave.pageDescription`).toBeUndefined();
      }
      expect(getPath(en, key)).not.toBe('Leave types and their entitlement policies');
    }
    // The heading strings the reporter listed, in English.
    expect(en.nav.leaveEntitlements).toBe('Entitlements');
    expect(en.nav.leaveBalanceHealth).toBe('Leave Balance Health');
    expect(en.nav.leaveAdjustments).toBe('Leave Adjustments');
    // 3f15ffdb (r362) — the reporter's own words for the row they asked for, kept verbatim.
    expect(en.nav.leaveHistoryImport).toBe('Leave History Data Import');
    // db55d08a (r369) — the reporter's own words again, kept verbatim: they asked for "Leave B/F Data
    // Import" and B/F is the abbreviation their own template uses, so it is not expanded here.
    expect(en.nav.leaveBfImport).toBe('Leave B/F Data Import');
    expect(en.nav.leaveGenerate).toBe('Generate Entitlement');
    expect(en.nav.leaveEarnedAccrual).toBe('Run Earned Accrual');
    expect(en.nav.leaveApprovalWorkflow).toBe('Approval Workflow');
    expect(en.nav.leaveCompanyRules).toBe('Company rules');
      expect(en.nav.leaveSpecialSetting).toBe('Special Setting');
      // THE ROW IS THE CATEGORY AND THE TAB IS THE SETTING — the r266 rule, and what makes a second
      // special setting an addition rather than a rename of a row the customer has learned.
      expect(en.admin.leaveConfigMap.item.specialSetting).toBe('Half-day deduction');
    // m7 was REVERTED: nav.leaveApproval labels the leaveApproval SCREEN in the users access grid and
    // test/leave-flyout-nav.test.ts (645e67c4) pins that it stays DISTINCT from the menu row's label —
    // a render check once caught the silent rename. The two surfaces keep their own names.
    expect(read('lib/permissions.ts')).toContain("labelKey: 'nav.leaveApproval',");
  });
});

describe('§D · the moves, and what deliberately did not move', () => {
  it('the Entitlements header carries NO actions at all, and F47 is served by the submenu row instead', () => {
    // 5ca446db (r269) — UPDATED, NOT DELETED. This case used to read "the header carries ONLY the Employee
    // Balances link (F47)". F47's property is unchanged — an HR admin looking one person's balances up must
    // find a way in from Leave Config — and it is now served by a permanent fly-out row present on EVERY
    // Leave Config screen instead of one underlined link on this one page, which is strictly stronger. The
    // reporter asked for that row twice. So the assertion moves with the property: the header is empty, and
    // the row is what carries the way in.
    const src = read('app/admin/leave-config/types/page.tsx');
    const header = src.slice(src.indexOf('<PageHeader'), src.indexOf('<LeaveConfigMap'));
    expect(header, 'the actions slot is gone, not emptied').not.toMatch(/actions=\{/);
    expect(header, 'no link survives in the header').not.toContain('<Link ');
    // The whole PAGE carries no link to the inquiry screen any more — not in the header, not anywhere.
    expect(src).not.toContain('href="/leave/employee-balances"');
    for (const gone of ['entitlementTablesAction', 'configurationRecordAction', 'balanceRecordAction', 'importAction', 'employeeBalancesAction'])
      expect(src, gone).not.toContain(gone);
    // THE WAY IN THAT REPLACED IT — asserted here so this case can never go green on a page that simply
    // lost its link with nothing put in its place.
    expect(CHILDREN.map((c) => c.href)).toContain('/leave/employee-balances');
    // …and the orphaned caption retires with its only reader, in all six catalogues.
    for (const [loc, cat] of Object.entries(CATALOGUES))
      expect(getPath(cat, 'admin.leave.employeeBalancesAction'), `${loc}: the caption must be pruned`).toBeUndefined();
  });

  it('r281 — Run earned accrual is on its OWN page, once, and tab 3 still points at it', () => {
    // r281 (09386e29) — UPDATED, NOT LOOSENED, and the subject of this case is unchanged: the tool is
    // mounted in exactly ONE place, the leave type tab that lost it keeps a pointer, and the tool's five
    // inputs are untouched so nothing about the calculation moved with the mount. What changed is WHICH
    // one place. r266 put it on Generate Entitlement; that screen CREATES a leave year's entitlement and
    // this one tops up what was already earned, so filing the second inside the first put an operator one
    // scroll from the operation it must never be confused with. It has a row and a page of its own now.
    const accrual = read('app/admin/leave-config/earned-accrual/page.tsx');
    const generate = read('app/admin/leave-config/generate/page.tsx');
    const types = read('app/admin/leave-config/types/page.tsx');
    const tabs = read('app/admin/leave-config/types/leave-type-tabs.tsx');
    expect(accrual.match(/<EarnedAccrualDialog/g)).toHaveLength(1);
    // ONE PLACE, NOT TWO: a half-done move that leaves a second mount behind fails here.
    expect(generate.match(/<EarnedAccrualDialog/g) ?? []).toHaveLength(0);
    expect(types.match(/<EarnedAccrualDialog/g) ?? []).toHaveLength(0);
    expect(types).toContain("leaveConfigScreenHref('earnedAccrual')");
    expect(types, 'the pointer must not still name the screen the tool left').not.toContain(
      "leaveConfigScreenHref('generateEntitlement')",
    );
    expect(types).toContain("t('entitlementStep.accrualMovedPointer')");
    expect(tabs).toContain('{accrualPointer}');
    // …AND THE SENTENCE MOVED WITH THE HREF. It read "Run earned accrual is under Generate Entitlement"
    // — a signpost that had already gone stale once — so repointing the link alone would have left a
    // caption that says one thing and does another (the r270 defect). It names no parent screen now.
    expect(en.admin.leave.entitlementStep.accrualMovedPointer).not.toMatch(/Generate Entitlement/);
    // The dialog's inputs are unchanged (the same five props), so the tool itself did not change.
    for (const prop of ['companies=', 'grades=', 'leaveTypes=', 'leaveYears=', 'defaultYear='])
      expect(accrual.slice(accrual.indexOf('<EarnedAccrualDialog'))).toContain(prop);
  });

  it('eligibility rules stay under Entitlements; Company rules only points at them', () => {
    const companyRules = read('app/admin/leave-config/company-rules/page.tsx');
    expect(companyRules).toContain("tPage('whoQualifies')");
    // r270 (995387c6) — UPDATED, NOT DELETED, AND THE PROPERTY IS NARROWED RATHER THAN LOOSENED.
    //
    // This case's subject is "Company rules hosts no eligibility editor and only POINTS at one", and that
    // is untouched: the two `not.toContain` lines below still carry it. What moved is the pointer's
    // TARGET. r266 sent it to the Entitlement tables tab because that tab mounted the Benefit schemes
    // card as well; r270 removes that duplicate copy, so the only place a scheme is edited is each leave
    // type's Entitlements tab on Leave types. A pointer left on the old target would survive every guard
    // in this file and land an administrator on a screen with no schemes on it.
    //
    // Pinned as the MAP CALL rather than the literal path, deliberately: the whole reason this page
    // resolves its link through `leaveConfigScreenHref` is that the page and the submenu cannot then
    // disagree about where a screen lives, and asserting the raw href would break that on the next move.
    expect(companyRules).toContain("leaveConfigScreenHref('leaveTypes')");
    expect(companyRules, 'the pointer must not still name the tab the schemes left').not.toContain(
      "leaveConfigScreenHref('entitlementTables')",
    );
    // …AND THE CAPTION MOVED WITH THE HREF. A render check caught this: repointing the link alone left
    // it reading "Open Entitlement tables" while opening Leave types — a control that says one thing and
    // does another, which is the very defect this repoint exists to prevent. The label is the map's own
    // name for the target now, the way the Replacement leave and Payroll impact pointers on this page
    // already are, so no third spelling of a screen name exists to drift.
    expect(companyRules, 'the link caption must name the screen it opens').toContain(
      "await leaveConfigScreenTitle('leaveTypes')",
    );
    expect(companyRules, 'the old caption key must not survive its href').not.toContain("tPage('whoQualifiesLink')");
    expect(companyRules).not.toContain('<EntitlementTablesBlock');
    expect(companyRules).not.toContain('EligibilityRuleForm');
    // The tables block is mounted where it was: the leave type's tab 3 and the Entitlement tables tab.
    expect(read('app/admin/leave-config/entitlement-tables/page.tsx')).toContain('<EntitlementTablesBlock');
    expect(read('app/admin/leave-config/types/page.tsx')).toContain('<EntitlementTablesBlock');
    // Approval Workflow and Company rules keep their content: the editors are still mounted.
    const approval = read('app/admin/leave-config/approval-chains/page.tsx');
    for (const needle of ['<ApprovalTemplateManager', '<ApprovalAssignmentManager', '<LeaveEscalationEditor'])
      expect(approval).toContain(needle);
    // r281 (a73d1e14) — THE HALF-DAY CARD LEFT THIS SCREEN, so the assertion follows the editor rather
    // than the address: it is on the Special Setting row now (the reporter asked for it under a heading
    // of its own), and it must be on EXACTLY one screen — asserted in both directions so a half-done move
    // that leaves a second copy behind, or one that loses the card altogether, both fail.
    expect(read('app/admin/leave-config/special-setting/page.tsx')).toContain('<HalfDayCompanyPicker');
    expect(companyRules, 'the half-day card must not survive on Company rules too').not.toContain(
      '<HalfDayCompanyPicker',
    );
    // r281 (cdd7500b) — SHARED LEAVE GROUPS LEFT THIS SCREEN TOO, at the reporter's request, and the
    // assertion follows the editor the same way. It is on the Leave types screen at PAGE LEVEL — above
    // the per-type workspace and outside it — which is the distinction the whole item turns on: it was
    // taken OFF that screen because it sat INSIDE the workspace, where it read as a property of the
    // selected type while a group spans several. So both halves are pinned: it is drawn on the types
    // page, and it is NOT inside the workspace's panels (a mount there would put it back where it was).
    //
    // ⚠️ "ABOVE THE WORKSPACE" IS ASSERTED AGAINST THE WORKSPACE'S OWN CARD, NOT AGAINST THE
    // `<LeaveTypeWorkspace` TAG. The first draft of this assertion compared against the tag, and a
    // deliberate break — moving the whole section INSIDE that Card, immediately before the workspace —
    // passed it, because the section is still textually earlier. The Card that carries `data-tour=
    // "leave-config"` IS the per-type workspace as far as the reader is concerned, so that is the
    // boundary the section must sit outside of.
    const types = read('app/admin/leave-config/types/page.tsx');
    expect(types).toContain('<LeaveSharedGroupConfig');
    expect(
      types.indexOf('<LeaveSharedGroupConfig'),
      'the shared-group section must render OUTSIDE and above the per-type workspace card — inside it, ' +
        'it reads as a property of the selected leave type, which is why it was taken off this screen',
    ).toBeLessThan(types.indexOf('<Card data-tour="leave-config">'));
    // …and it is not handed into the workspace as a slot either, which would be the same defect by prop.
    const workspaceMount = types.slice(types.indexOf('<LeaveTypeWorkspace'));
    expect(workspaceMount.slice(0, workspaceMount.indexOf('/>'))).not.toContain('SharedGroup');
    expect(companyRules, 'the shared-group card must not survive on Company rules too').not.toContain(
      '<LeaveSharedGroupConfig',
    );
    // Company rules keeps the section the reporter did not ask to move.
    expect(companyRules).toContain('setLeaveEncashmentPolicyAction');
    // 3fb1a611 (r299) — UPDATED, NOT LOOSENED: the replacement-leave policy (F38) left too, for Leave Config ›
    // Leave Credit's Rules tab (test/leave-replacement-config.test.ts follows the editor there). Asserted
    // ABSENT, so a copy left behind — two editors for one policy — fails here.
    expect(companyRules).not.toContain('setToilPolicyAction');
  });

  it('the submenu row stays lit on its tabs: the two rows own exactly their other tabs (plus the named sub-screen)', () => {
    // 7f69bd71 — Leave Adjustments also owns the Reset records sub-screen, so the row stays lit on it and
    // on the two records/* stubs on the way through. Nothing else is owned by anyone.
    const SUB_SCREENS: Record<string, string[]> = {
      leaveAdjustments: [LEAVE_CONFIG_RECORDS_HREF],
      leaveDataImport: ['/admin/leave-config/history-import', '/admin/leave-config/bf-import'],
    };
    for (const g of LEAVE_CONFIG_MAP) {
      const row = ROWS.find((r) => r.labelKey === g.navKey)!;
      expect(row.ownedSubpaths ?? []).toEqual([...g.items.slice(1).map((i) => i.href), ...(SUB_SCREENS[g.navKey] ?? [])]);
    }
  });

  it('the tour anchor and route stay where they were', () => {
    const tours = JSON.parse(read('lib/module-tours.json')) as Record<string, { steps: { route: string; target: string | null }[] }>;
    const step = Object.values(tours).flatMap((m) => m.steps).find((x) => x.target === '[data-tour="leave-config"]');
    expect(step?.route).toBe('/admin/leave-config/types');
    expect(read('app/admin/leave-config/types/page.tsx')).toContain('data-tour="leave-config"');
  });
});

describe('§E · the strings, six locales', () => {
  const NEW_OR_RENAMED = [
    'admin.leaveConfigMap.label',
    'admin.leaveConfigMap.item.entitlementArchive',
    'admin.leaveConfigMap.item.ledgerArchive',
    'admin.leaveConfigMap.item.adjustments',
    'admin.leaveConfigTypes.rowDescription',
    'admin.leaveConfigAdjustments.pageDescription',
    'admin.leaveConfigGenerate.pageDescription',
    'admin.leaveConfigCompanyRules.whoQualifies',
    // r271 (6d29e11c) — `whoQualifiesLink` is PRUNED from all six catalogues. r270 repointed this pointer
    // at Leave types and captioned it from the map's own screen title, which orphaned the old caption
    // ("Open Entitlement tables"); it then survived a round as a dead string in six files. A key nothing
    // renders cannot be pinned as one every catalogue must carry — the assertion below would keep six
    // translations of a caption alive forever. The sentence it sat beside is still pinned, above.

    'admin.leave.entitlementStep.accrualMovedPointer',
    // r281 (09386e29) — Run earned accrual's own row: the nav label, the map item label and the row
    // description. Pinned here because every one of them can ship English-only behind a green 200.
    'nav.leaveEarnedAccrual',
    'admin.leaveConfigMap.item.earnedAccrual',
    'admin.leaveConfigEarnedAccrual.pageDescription',
    // r281 (a73d1e14) — Special Setting's own row: the nav label, the map item label and the row
    // description.
    'nav.leaveSpecialSetting',
    'admin.leaveConfigMap.item.specialSetting',
    'admin.leaveConfigSpecialSetting.pageDescription',
    'admin.entitlementArchive.pageDescription',
    // 3f15ffdb (r362) — Leave History Data Import's own row: the nav label, the map item label and the
    // row description, PLUS the RENAMED label of its sibling tab. Every one of them can ship
    // English-only behind a green 200, which is what this list is for.
    'nav.leaveHistoryImport',
    'admin.leaveConfigMap.item.leaveHistoryImport',
    'admin.leaveConfigHistoryImport.pageDescription',
    'admin.leaveConfigMap.item.importLeaveData',
    // db55d08a (r369) — Leave B/F Data Import's own row: the nav label, the map item label and the row
    // description. Every one of them can ship English-only behind a green 200, which is what this list is
    // for — and the row description is the one that would otherwise go unnoticed, because nothing renders
    // it until somebody opens the page in a non-English locale.
    'nav.leaveBfImport',
    'admin.leaveConfigMap.item.leaveBfImport',
    'admin.leaveConfigBfImport.pageDescription',
  ];
  it('every key exists in all six catalogues and is not left in English outside en', () => {
    for (const key of NEW_OR_RENAMED) {
      const enValue = getPath(en, key);
      expect(typeof enValue, key).toBe('string');
      for (const [loc, cat] of Object.entries(CATALOGUES)) {
        const v = getPath(cat, key);
        expect(typeof v, `${loc} ${key}`).toBe('string');
        if (loc !== 'en') expect(v, `${loc} ${key} untranslated`).not.toBe(enValue);
      }
    }
  });

  it('one screen, one name: the tab labels are the names the header links used, and the pills\' names are gone', () => {
    expect(en.admin.leaveConfigMap.item.entitlementArchive).toBe('Configuration record');
    expect(en.admin.leaveConfigMap.item.ledgerArchive).toBe('Balance record');
    expect(en.admin.leaveConfigMap.item.adjustments).toBe('Adjust balances');
    expect(en.admin.leaveConfigMap.item.leaveTypes).toBe('Leave types');
    expect(en.admin.leaveConfigMap.item.entitlementTables).toBe('Entitlement tables');
    // 3f15ffdb (r362) — UPDATED, NOT LOOSENED, and the old claim is quoted so the change is legible:
    // this read `expect(en.admin.leaveConfigMap.item.importLeaveData).toBe('Import leave data')`.
    // That name became ambiguous the moment a second importer joined the menu, because "leave data" is
    // exactly what BOTH of them load — this one loads the BALANCES and the new row loads the RECORDS.
    // The LABEL is all that changed: the screen id `importLeaveData`, the route
    // `/admin/leave-config/import` and every stored role config are untouched, and both are asserted
    // below so a rename that quietly moved the screen would fail here.
    expect(en.admin.leaveConfigMap.item.importLeaveData).toBe('Leave Balance Import');
    expect(en.admin.leaveConfigMap.item.leaveHistoryImport).toBe('Leave History Data Import');
    // db55d08a (r369) — the tab label equals the row label for a group of one, exactly as its neighbour's
    // does: there is one screen, so there is one name for it.
    expect(en.admin.leaveConfigMap.item.leaveBfImport).toBe('Leave B/F Data Import');
    expect(LEAVE_CONFIG_MAP.flatMap((g) => g.items).find((i) => i.id === 'importLeaveData')!.href).toBe(
      '/admin/leave-config/import',
    );
    // The record's stale description no longer names the Benefit Scheme layer release three removed.
    expect(en.admin.entitlementArchive.pageDescription).not.toMatch(/Benefit Scheme/);
    expect(en.admin.entitlementArchive.pageDescription).toMatch(/reset/);
    // The keys whose only readers left with the header links and back-links are pruned.
    for (const gone of [
      'admin.leave.entitlementTablesAction',
      'admin.leave.configurationRecordAction',
      'admin.leave.balanceRecordAction',
      'admin.leave.importAction',
      'admin.leave.import.backLabel',
      'admin.entitlementTemplates.backToEntitlements',
      'admin.entitlementArchive.backToEntitlements',
      'admin.leaveLedgerArchive.backToEntitlements',
      'admin.leaveConfigTypes.pageDescription',
      // 5ca446db (r269) — the LAST header caption goes the same way, with the link it labelled. Grepped
      // first (the r137 rule): its one reader was app/admin/leave-config/types/page.tsx, and no computed
      // `t(\`…\`)` form in any file reading the `admin.leave` namespace can reach it.
      'admin.leave.employeeBalancesAction',
    ]) {
      for (const [loc, cat] of Object.entries(CATALOGUES)) expect(getPath(cat, gone), `${loc} ${gone}`).toBeUndefined();
    }
  });
});
