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
import { describe, expect, it } from 'vitest';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

import { LEAVE_CONFIG_MAP, leaveConfigGroupOf, type MappedLeaveConfigScreenId } from '../components/leave-config-map';
import { leavePack } from '../packs/leave';
import { SCREENS } from '../lib/permissions';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');
const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Dict = Record<string, unknown>;
const getPath = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);

/** Every guarded page of the module, walked from disk so a page added later cannot skip this. */
function pages(dir = 'app/admin/leave-config', out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) pages(p, out);
    else if (e.name === 'page.tsx') out.push(p);
  }
  return out;
}
const PAGES = pages();
const MAP_SRC = read('components/leave-config-map.tsx');
const MAP_CODE = stripComments(MAP_SRC);
const ROWS = leavePack.navNodes!.find((n) => n.group === 'admin')!.children;

describe('§A · the map is the five submenu rows, in the submenu\'s order', () => {
  it('group ↔ row agreement, both directions, first item = the row\'s own href', () => {
    expect(LEAVE_CONFIG_MAP.map((g) => g.navKey)).toEqual(ROWS.map((r) => r.labelKey));
    expect(LEAVE_CONFIG_MAP.map((g) => g.items[0].href)).toEqual(ROWS.map((r) => r.href));
    expect(ROWS).toHaveLength(5);
  });

  it('every leaveConfig route is on exactly one row, and no route moved (bookmarks keep working)', () => {
    const leaveConfig = SCREENS.find((s) => s.screenKey === 'leaveConfig')!;
    const onMap = LEAVE_CONFIG_MAP.flatMap((g) => g.items.map((i) => i.href));
    for (const r of leaveConfig.routes) expect(onMap.filter((h) => h === r), r).toHaveLength(1);
    expect(onMap).toEqual([
      '/admin/leave-config/types',
      '/admin/leave-config/entitlement-tables',
      '/admin/leave-config/records/entitlement',
      '/admin/leave-config/adjustments',
      '/admin/leave-config/records/balances',
      '/admin/leave-config/import',
      '/admin/leave-config/generate',
      '/admin/leave-config/approval-chains',
      '/admin/leave-config/company-rules',
    ]);
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

  it('the rows with tabs are exactly Entitlements and Leave Adjustments, three each', () => {
    const withTabs = LEAVE_CONFIG_MAP.filter((g) => g.items.length > 1).map((g) => [g.id, g.items.length]);
    expect(withTabs).toEqual([
      ['entitlements', 3],
      ['adjustments', 3],
    ]);
  });
});

describe('§C · every page\'s heading is its submenu row, and its description is the row\'s', () => {
  it('each page reads its PageHeader through leaveConfigPageHeader(<its own id>)', () => {
    for (const rel of PAGES) {
      const src = read(rel);
      const id = src.match(/<LeaveConfigMap current="([a-zA-Z]+)" \/>/)![1];
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
      adjustments: 'admin.leaveConfigAdjustments.pageDescription',
      generate: 'admin.leaveConfigGenerate.pageDescription',
      approval: 'admin.leaveConfigApprovalChains.pageDescription',
      companyRules: 'admin.leaveConfigCompanyRules.pageDescription',
    };
    for (const [group, key] of Object.entries(descriptionKeys)) {
      const [ns, leaf] = [key.slice(0, key.lastIndexOf('.')), key.slice(key.lastIndexOf('.') + 1)];
      expect(MAP_CODE, `${group} description key`).toContain(`${group}: ['${ns}', '${leaf}']`);
      for (const [loc, cat] of Object.entries(CATALOGUES)) {
        const v = getPath(cat, key);
        expect(typeof v, `${loc} ${key}`).toBe('string');
        // The two wrong descriptions are replaced: nothing under a row heading is the Leave types sentence.
        expect(v, `${loc} ${key} borrows the Leave types sentence`).not.toBe(getPath(cat, 'admin.leave.pageDescription'));
      }
    }
    // The heading strings the reporter listed, in English.
    expect(en.nav.leaveEntitlements).toBe('Entitlements');
    expect(en.nav.leaveAdjustments).toBe('Leave Adjustments');
    expect(en.nav.leaveGenerate).toBe('Generate Entitlement');
    expect(en.nav.leaveApprovalWorkflow).toBe('Approval Workflow');
    expect(en.nav.leaveCompanyRules).toBe('Company rules');
    // Adjustments and Generate stop reading admin.leave.pageDescription.
    for (const rel of ['app/admin/leave-config/adjustments/page.tsx', 'app/admin/leave-config/generate/page.tsx']) {
      expect(stripComments(read(rel))).not.toContain("t('pageDescription')");
    }
  });
});

describe('§D · the moves, and what deliberately did not move', () => {
  it('the Entitlements header carries only the Employee Balances link (F47), and no + Import', () => {
    const src = read('app/admin/leave-config/types/page.tsx');
    const header = src.slice(src.indexOf('<PageHeader'), src.indexOf('<LeaveConfigMap'));
    expect(header).toContain('href="/leave/employee-balances"');
    expect((header.match(/<Link /g) ?? []).length).toBe(1);
    for (const gone of ['entitlementTablesAction', 'configurationRecordAction', 'balanceRecordAction', 'importAction'])
      expect(src, gone).not.toContain(gone);
  });

  it('Run earned accrual is on Generate Entitlement, once, and tab 3 keeps a pointer to it', () => {
    const generate = read('app/admin/leave-config/generate/page.tsx');
    const types = read('app/admin/leave-config/types/page.tsx');
    const tabs = read('app/admin/leave-config/types/leave-type-tabs.tsx');
    expect(generate.match(/<EarnedAccrualDialog/g)).toHaveLength(1);
    expect(types.match(/<EarnedAccrualDialog/g) ?? []).toHaveLength(0);
    expect(types).toContain("leaveConfigScreenHref('generateEntitlement')");
    expect(types).toContain("t('entitlementStep.accrualMovedPointer')");
    expect(tabs).toContain('{accrualPointer}');
    // The dialog's inputs are unchanged (the same five props), so the tool itself did not change.
    for (const prop of ['companies=', 'grades=', 'leaveTypes=', 'leaveYears=', 'defaultYear='])
      expect(generate.slice(generate.indexOf('<EarnedAccrualDialog'))).toContain(prop);
  });

  it('eligibility rules stay under Entitlements; Company rules only points at them', () => {
    const companyRules = read('app/admin/leave-config/company-rules/page.tsx');
    expect(companyRules).toContain("tPage('whoQualifies')");
    expect(companyRules).toContain("leaveConfigScreenHref('entitlementTables')");
    expect(companyRules).not.toContain('<EntitlementTablesBlock');
    expect(companyRules).not.toContain('EligibilityRuleForm');
    // The tables block is mounted where it was: the leave type's tab 3 and the Entitlement tables tab.
    expect(read('app/admin/leave-config/entitlement-tables/page.tsx')).toContain('<EntitlementTablesBlock');
    expect(read('app/admin/leave-config/types/page.tsx')).toContain('<EntitlementTablesBlock');
    // Approval Workflow and Company rules keep their content: the editors are still mounted.
    const approval = read('app/admin/leave-config/approval-chains/page.tsx');
    for (const needle of ['<ApprovalTemplateManager', '<ApprovalAssignmentManager', '<LeaveEscalationEditor'])
      expect(approval).toContain(needle);
    for (const needle of ['<HalfDayCompanyPicker', '<LeaveSharedGroupConfig'])
      expect(companyRules).toContain(needle);
  });

  it('the submenu row stays lit on its tabs: the two rows own exactly their other tabs', () => {
    for (const g of LEAVE_CONFIG_MAP) {
      const row = ROWS.find((r) => r.labelKey === g.navKey)!;
      expect(row.ownedSubpaths ?? []).toEqual(g.items.slice(1).map((i) => i.href));
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
    'admin.leaveConfigCompanyRules.whoQualifiesLink',
    'admin.leave.entitlementStep.accrualMovedPointer',
    'admin.entitlementArchive.pageDescription',
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
    expect(en.admin.leaveConfigMap.item.importLeaveData).toBe('Import leave data');
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
    ]) {
      for (const [loc, cat] of Object.entries(CATALOGUES)) expect(getPath(cat, gone), `${loc} ${gone}`).toBeUndefined();
    }
  });
});
