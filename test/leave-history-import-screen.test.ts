/**
 * 3f15ffdb (r362) — THE LEAVE HISTORY DATA IMPORT SCREEN, and the keys the coverage guard cannot see.
 *
 * `test/i18n-coverage.test.ts` check C only resolves LITERAL `t('a.b')` keys in single-namespace files.
 * Two key families on this screen are computed, so they are invisible to it and would ship as raw
 * `admin.leaveHistoryImport.step.validate` text behind a green everything:
 *
 *   · the six step labels, rendered as `` t(`step.${s}`) `` over LEAVE_HISTORY_STEPS;
 *   · the five upload-failure messages, resolved through `importFileMessageKey(e)` — the same
 *     computed-key hazard test/employee-import-file.test.ts pins for the employee importer.
 *
 * Both are pinned here, in all six catalogues, with the untranslated-copy check the §E guard uses.
 * The rest of the file is the screen's shape: the three registries agree, the page is a server
 * component that reads its heading through the row helper, and the reporter's six steps are in the
 * reporter's order.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import { LEAVE_CONFIG_MAP } from '../components/leave-config-map';
import { leavePack } from '../packs/leave';
import { REGISTERED_ROUTES, SCREENS } from '../lib/permissions';
import { IMPORT_FILE_MESSAGE_KEYS } from '../lib/import-file';
import {
  LEAVE_HISTORY_COLUMNS,
  LEAVE_HISTORY_REQUIRED_KEYS,
  LEAVE_HISTORY_STEPS,
  leaveHistoryRunOutcome,
} from '../lib/leave-history-import-schema';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CATALOGUES = { en, ms, ta, th, vi: vi_, zh } as const;
type Dict = Record<string, unknown>;
const getPath = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);

const HREF = '/admin/leave-config/history-import';
const PAGE = 'app/admin/leave-config/history-import/page.tsx';
const ISLAND = 'app/admin/leave-config/history-import/leave-history-import.tsx';
const ACTIONS = 'app/admin/leave-config/history-import/actions.ts';

describe('the three registries agree about the new row', () => {
  it('the fly-out row, the map group and the permission route all name the same address', () => {
    const children = leavePack.navNodes!.find((n) => n.group === 'admin')!.children;
    const row = children.find((c) => c.href === HREF);
    expect(row, 'the Leave Config fly-out must carry the row').toBeTruthy();
    expect(row!.labelKey).toBe('leaveHistoryImport');
    // One page, no tabs, no sub-screen — so nothing for the row to stay lit on beyond its own href.
    expect(row!.ownedSubpaths ?? []).toEqual([]);
    // Not module-gated: leave is core (Leave Credit is the only gated row of this node).
    expect(row!.adminOnly).toBeUndefined();
    expect(row!.managerUp).toBeUndefined();

    const group = LEAVE_CONFIG_MAP.find((g) => g.navKey === 'leaveHistoryImport')!;
    expect(group, 'every Leave Config row is a group; this one must be too').toBeTruthy();
    expect(group.items.map((i) => i.href)).toEqual([HREF]);

    expect(REGISTERED_ROUTES.has(HREF)).toBe(true);
    const owner = SCREENS.find((s) => s.routes.includes(HREF))!;
    // The EXISTING key, never a new one: a screenKey may key stored role configs, so minting one for a
    // sibling of the balance importer would create a permission nobody has been granted.
    expect(owner.screenKey).toBe('leaveConfig');
    expect(owner.guard).toBe('requireAdmin');
  });

  it('it sits immediately after Leave Adjustments — the balance importer, then the record importer', () => {
    const labels = leavePack.navNodes!.find((n) => n.group === 'admin')!.children.map((c) => c.labelKey);
    const i = labels.indexOf('leaveAdjustments');
    expect(labels[i + 1]).toBe('leaveHistoryImport');
    // …and the same order in the map, which is what test/r266 asserts both ways.
    const ids = LEAVE_CONFIG_MAP.map((g) => g.id);
    expect(ids[ids.indexOf('adjustments') + 1]).toBe('leaveHistoryImport');
  });

  it('the older importer is RENAMED, not moved: same id, same route, new label only', () => {
    const balanceTab = LEAVE_CONFIG_MAP.flatMap((g) => g.items).find((i) => i.id === 'importLeaveData')!;
    expect(balanceTab.href).toBe('/admin/leave-config/import');
    expect(SCREENS.find((s) => s.screenKey === 'leaveConfig')!.routes).toContain('/admin/leave-config/import');
    expect(en.admin.leaveConfigMap.item.importLeaveData).toBe('Leave Balance Import');
    // …and it is still a TAB of Leave Adjustments, not a row of its own.
    expect(LEAVE_CONFIG_MAP.find((g) => g.id === 'adjustments')!.items.map((i) => i.id)).toContain('importLeaveData');
  });
});

describe('the page is the house shape', () => {
  it('server component, guarded, heading through the row helper, map mounted once', () => {
    const src = read(PAGE);
    expect(src).toContain('requireAdmin()');
    expect(src).toContain("leaveConfigPageHeader('leaveHistoryImport')");
    expect(src.match(/<LeaveConfigMap current="leaveHistoryImport" \/>/g)).toHaveLength(1);
    // Not a client component, and it must stay one — the r123 class test/server-client-boundary pins.
    expect(src.startsWith("'use client'")).toBe(false);
    // The log is read on the SERVER so it is RLS-scoped, not fetched from the island.
    expect(src).toContain('listLeaveHistoryImportRuns(s)');
    // The heading is NOT the tab label (the mismatch r266 measured across four screens).
    const headerBlock = src.slice(src.indexOf('<PageHeader'), src.indexOf('/>', src.indexOf('<PageHeader')));
    expect(headerBlock).not.toContain('leaveConfigScreenTitle(');
  });

  it('both server actions are behind requireAdmin — ticket point 11, on the write path too', () => {
    const src = read(ACTIONS);
    expect(src).toContain("'use server'");
    expect(src.match(/await requireAdmin\(\)/g) ?? []).toHaveLength(2);
    // The server receives TEXT and re-parses it: no workbook ever reaches a server action.
    expect(src).toContain('parseCsvRecords(csv)');
    expect(src).not.toMatch(/workbookToCsv|buildXlsx/);
  });

  it('the island reads the file in the BROWSER, through the one decoder this repo has', () => {
    const src = read(ISLAND);
    expect(src.startsWith("'use client'")).toBe(true);
    expect(src).toContain('readImportFile(file)');
    expect(src).toContain('IMPORT_FILE_ACCEPT');
    // The error report echoes user-supplied cells back into a file Excel will open, so it must go
    // through toCsv's formula-injection guard rather than being joined by hand.
    expect(src).toContain("import { toCsv } from '@/lib/csv'");
    expect(src).not.toMatch(/\.join\(','\)[\s\S]{0,40}Blob/);
  });
});

describe('the six steps are the reporter’s six, in the reporter’s order', () => {
  it('the rail is derived from the contract, not hand-listed in the component', () => {
    expect([...LEAVE_HISTORY_STEPS]).toEqual([
      'downloadTemplate',
      'uploadExcel',
      'validate',
      'previewResults',
      'confirmImport',
      'importSummary',
    ]);
    const src = read(ISLAND);
    expect(src).toContain('LEAVE_HISTORY_STEPS.map(');
    // Not clickable: a rail you can click your way along lies about where you are.
    expect(src).not.toMatch(/onClick=\{\(\) => setStep/);
  });

  it('every step label resolves in all six catalogues (a COMPUTED key the coverage guard cannot see)', () => {
    for (const s of LEAVE_HISTORY_STEPS) {
      const key = `admin.leaveHistoryImport.step.${s}`;
      const enValue = getPath(en, key);
      expect(typeof enValue, key).toBe('string');
      for (const [loc, cat] of Object.entries(CATALOGUES)) {
        const v = getPath(cat, key);
        expect(typeof v, `${loc} ${key}`).toBe('string');
        if (loc !== 'en') expect(v, `${loc} ${key} is the English string copied across`).not.toBe(enValue);
      }
    }
  });

  it('every upload-failure message resolves in all six catalogues (also computed)', () => {
    // `importFileMessageKey(e)` returns one of these five, relative to THIS screen's namespace.
    for (const leaf of Object.values(IMPORT_FILE_MESSAGE_KEYS)) {
      const key = `admin.leaveHistoryImport.${leaf}`;
      const enValue = getPath(en, key);
      expect(typeof enValue, key).toBe('string');
      for (const [loc, cat] of Object.entries(CATALOGUES)) {
        const v = getPath(cat, key);
        expect(typeof v, `${loc} ${key}`).toBe('string');
        if (loc !== 'en') expect(v, `${loc} ${key} is the English string copied across`).not.toBe(enValue);
      }
    }
    expect(Object.keys(IMPORT_FILE_MESSAGE_KEYS)).toHaveLength(5); // non-vacuity: the loop ran
  });
});

describe('the decision the reporter must not be surprised by is ON the screen', () => {
  it('the no-balance notice is always rendered, and says both the what and the why', () => {
    const src = read(ISLAND);
    expect(src).toContain('<NoBalanceNotice />');
    // Not conditional on a result: the surprise it prevents ("why has Taken not moved?") arrives days
    // later, so the explanation must be there before the import as well as after it.
    expect(src).not.toMatch(/\{\s*result\s*&&\s*<NoBalanceNotice/);
    for (const [loc, cat] of Object.entries(CATALOGUES)) {
      expect(typeof getPath(cat, 'admin.leaveHistoryImport.noBalanceTitle'), loc).toBe('string');
      const body = getPath(cat, 'admin.leaveHistoryImport.noBalanceBody');
      expect(typeof body, loc).toBe('string');
      // It must carry the REASON, not only the fact — the plan's own argument, which is what stops an
      // administrator reading the behaviour as a bug and asking for it to be "fixed".
      //
      // MEASURED AGAINST THE TITLE IN THE SAME LOCALE, which is the only script-neutral way to ask
      // "is this a paragraph or a restatement". Two earlier drafts of this case were wrong and both
      // failures are worth recording, because each looked right until a locale disproved it:
      //   · `body.length > 160` failed on Chinese at 127 characters while saying everything the
      //     English says — a character count measures SCRIPT DENSITY, not content;
      //   · counting sentence-ending punctuation failed on Thai, which does not use it at all.
      // A ratio to the locale's own title cancels both. The observed spread is 10.2 (vi) to 17.4 (en),
      // so 6 is comfortably below every real translation and far above a one-line restatement.
      const title = getPath(cat, 'admin.leaveHistoryImport.noBalanceTitle') as string;
      expect(
        (body as string).length / title.length,
        `${loc} noBalanceBody must carry the reason, not only the fact`,
      ).toBeGreaterThan(6);
    }
    // …and the English one states the actual argument in the plan's own word.
    expect(en.admin.leaveHistoryImport.noBalanceBody).toMatch(/twice/);
  });
});

describe('the contract the screen and the validator share', () => {
  it('twelve columns, six required, in the ticket’s order', () => {
    expect(LEAVE_HISTORY_COLUMNS.map((c) => c.header)).toEqual([
      'Employee No.',
      'Leave Reference',
      'Leave Code',
      'Entitlement Year',
      'Leave Start Date',
      'Leave End Date',
      'Number of Day',
      'Session',
      'Entry Date',
      'Submit Date',
      'Approved Date',
      'Remark',
    ]);
    expect([...LEAVE_HISTORY_REQUIRED_KEYS]).toEqual([
      'employee_no',
      'leave_reference',
      'leave_code',
      'leave_start_date',
      'leave_end_date',
      'number_of_day',
    ]);
    // The column reference on the screen is DERIVED from the contract, so it cannot drift from it.
    expect(read(ISLAND)).toContain('LEAVE_HISTORY_COLUMNS.map(');
  });

  it('the run outcome is derived from the counts, so no badge can disagree with the numbers beside it', () => {
    expect(leaveHistoryRunOutcome({ importedRows: 10, failedRows: 0 })).toBe('succeeded');
    expect(leaveHistoryRunOutcome({ importedRows: 8, failedRows: 2 })).toBe('partial');
    expect(leaveHistoryRunOutcome({ importedRows: 0, failedRows: 3 })).toBe('failed');
    // A re-upload where every row was already there imported nothing and failed nothing. That is a
    // correct, expected outcome — calling it a failure would train HR to ignore the badge.
    expect(leaveHistoryRunOutcome({ importedRows: 0, failedRows: 0 })).toBe('succeeded');
  });
});
