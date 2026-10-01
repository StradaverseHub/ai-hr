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
  resolveLeaveHistoryImportOptions,
} from '../lib/leave-history-import-schema';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CATALOGUES = { en, ms, ta, th, vi: vi_, zh } as const;
type Dict = Record<string, unknown>;
const getPath = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);

const HREF = '/admin/leave-config/data-import';
const PAGE = 'app/admin/leave-config/data-import/page.tsx';
const ISLAND = 'app/admin/leave-config/history-import/leave-history-import.tsx';
const ACTIONS = 'app/admin/leave-config/history-import/actions.ts';

describe('the three registries agree about the new row', () => {
  it('the fly-out row, the map group and the permission route all name the same address', () => {
    const children = leavePack.navNodes!.find((n) => n.group === 'admin')!.children;
    const row = children.find((c) => c.href === HREF);
    expect(row, 'the Leave Config fly-out must carry the row').toBeTruthy();
    expect(row!.labelKey).toBe('leaveDataImport');
    // One page, no tabs, no sub-screen — so nothing for the row to stay lit on beyond its own href.
    expect(row!.ownedSubpaths ?? []).toEqual(['/admin/leave-config/history-import', '/admin/leave-config/bf-import']);
    // Not module-gated: leave is core (Leave Credit is the only gated row of this node).
    expect(row!.adminOnly).toBeUndefined();
    expect(row!.managerUp).toBeUndefined();

    const group = LEAVE_CONFIG_MAP.find((g) => g.navKey === 'leaveDataImport')!;
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
    expect(labels[i + 1]).toBe('leaveDataImport');
    // …and the same order in the map, which is what test/r266 asserts both ways.
    const ids = LEAVE_CONFIG_MAP.map((g) => g.id);
    expect(ids[ids.indexOf('adjustments') + 1]).toBe('leaveDataImport');
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
    expect(src).toContain("leaveConfigPageHeader('leaveDataImport')");
    expect(src.match(/<LeaveConfigMap current="leaveDataImport" \/>/g)).toHaveLength(1);
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
    expect(src).toMatch(/import\s*\{[^}]*\btoCsv\b[^}]*\} from '@\/lib\/csv'/);
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

describe('r367 — the decision the reporter must not be surprised by is ON the screen, and it is now a CHOICE', () => {
  /**
   * ⚠️ THIS BLOCK USED TO PIN THE OPPOSITE, AND IS UPDATED RATHER THAN DELETED (CLAUDE.md section 8: a
   * guard pinning a decision you are reversing is updated, not deleted).
   *
   * r362 asserted `admin.leaveHistoryImport.noBalanceBody` must "carry the REASON, not only the fact",
   * and measured it: a body-to-title length ratio above 6 in every locale, and the English one matching
   * /twice/. Both of those were honest measurements of a sentence that should never have been printed —
   * "the balances you migrate already have this leave removed from them" is a claim about the CUSTOMER'S
   * DATA that this product never asked about and cannot verify, and it is false for the reporter of
   * 073233bb. The key is RETIRED IN PLACE, never deleted, and the same measurement now applies to the two
   * sentences that replaced it, one per answer.
   *
   * The two earlier drafts of the ratio case are worth keeping recorded, because each looked right until
   * a locale disproved it:
   *   · `body.length > 160` failed on Chinese at 127 characters while saying everything the English says
   *     — a character count measures SCRIPT DENSITY, not content;
   *   · counting sentence-ending punctuation failed on Thai, which does not use it at all.
   * A ratio to the locale's own title cancels both.
   */
  it('the retired sentence is gone from the screen, and the key survives in all six catalogues', () => {
    const src = read(ISLAND);
    // RETIRED IN PLACE: the key must still resolve everywhere (a deleted key is a MISSING_MESSAGE
    // somewhere nobody looked), and it must no longer be rendered anywhere.
    for (const [loc, cat] of Object.entries(CATALOGUES)) {
      expect(typeof getPath(cat, 'admin.leaveHistoryImport.noBalanceBody'), loc).toBe('string');
      expect(typeof getPath(cat, 'admin.leaveHistoryImport.noBalanceTitle'), loc).toBe('string');
    }
    expect(src).not.toMatch(/t\('noBalanceBody'\)/);
    expect(src).not.toMatch(/t\('noBalanceTitle'\)/);
    // …and the English retirement says so in words, so the next reader does not restore it.
    expect(en.admin.leaveHistoryImport.noBalanceBody).toMatch(/RETIRED/);
    // The claim it made about the customer's data must not survive anywhere that is rendered.
    for (const key of ['effectDeductBody', 'effectNetBody', 'netNoHint', 'netYesHint'] as const) {
      expect(
        en.admin.leaveHistoryImport[key],
        `${key} must not re-assert that the customer's migrated balances are already net`,
      ).not.toMatch(/balances you migrate already have/);
    }
  });

  it('the per-run choice is rendered, with BOTH answers labelled and the deducting one the default', () => {
    const src = read(ISLAND);
    expect(src).toContain('<BalanceQuestion');
    // Two radios, not a checkbox: a checkbox makes one answer the unlabelled absence of the other, and
    // both answers here are real migration shapes a reader has to recognise their own file in.
    expect(src).toMatch(/type="radio"/);
    expect(src).toContain("name=\"openingBalancesAreNet\"");
    // The default comes from the CONTRACT, never from a literal `false` in the component — the server
    // resolves through the same function, so the control cannot start out on the other arithmetic.
    expect(src).toContain('resolveLeaveHistoryImportOptions()');
    expect(resolveLeaveHistoryImportOptions().openingBalancesAreNet).toBe(false);
    expect(resolveLeaveHistoryImportOptions({}).openingBalancesAreNet).toBe(false);
    expect(resolveLeaveHistoryImportOptions({ openingBalancesAreNet: true }).openingBalancesAreNet).toBe(true);
    for (const key of ['netQuestion', 'netNoLabel', 'netYesLabel', 'netNoHint', 'netYesHint'] as const) {
      for (const [loc, cat] of Object.entries(CATALOGUES)) {
        expect(typeof getPath(cat, `admin.leaveHistoryImport.${key}`), `${loc} ${key}`).toBe('string');
      }
    }
  });

  it('the effect notice is always rendered, states BOTH outcomes, and each carries its reason', () => {
    const src = read(ISLAND);
    expect(src).toContain('<BalanceEffectNotice');
    // Not conditional on a result: the surprise it prevents ("why has Taken not moved?") arrives days
    // later, so the explanation must be there before the import as well as after it.
    expect(src).not.toMatch(/\{\s*result\s*&&\s*<BalanceEffectNotice/);
    for (const [loc, cat] of Object.entries(CATALOGUES)) {
      for (const pair of [
        ['effectDeductTitle', 'effectDeductBody'],
        ['effectNetTitle', 'effectNetBody'],
      ] as const) {
        const title = getPath(cat, `admin.leaveHistoryImport.${pair[0]}`);
        const body = getPath(cat, `admin.leaveHistoryImport.${pair[1]}`);
        expect(typeof title, `${loc} ${pair[0]}`).toBe('string');
        expect(typeof body, `${loc} ${pair[1]}`).toBe('string');
        // The r362 measurement, kept and re-aimed: a paragraph, not a restatement of its own heading.
        expect(
          (body as string).length / (title as string).length,
          `${loc} ${pair[1]} must carry the reason, not only the fact`,
        ).toBeGreaterThan(6);
      }
    }
    // The "same days twice" argument belongs to the NET answer now, and only to it — printing it beside
    // the deducting answer is exactly the false statement this item removed.
    expect(en.admin.leaveHistoryImport.effectNetBody).toMatch(/twice/);
    expect(en.admin.leaveHistoryImport.effectDeductBody).not.toMatch(/twice/);
  });

  it('the balance impact is rendered ABOVE Confirm import, from the SERVER’s figures', () => {
    const src = read(ISLAND);
    expect(src).toContain('<BalanceImpactSection preview={preview} />');
    // Position is the requirement: the plan promised the reader sees the effect BEFORE pressing the
    // button, not in a summary afterwards.
    expect(src.indexOf('<BalanceImpactSection')).toBeLessThan(src.indexOf("t('confirmImport'"));
    // Every figure comes off the preview the server computed. A browser-side sum would be a second
    // derivation of a money figure and would disagree the first time the two drifted.
    expect(src).toContain('preview.balanceImpact');
    expect(src).toContain('preview.deducts');
    for (const key of [
      'impactTitle',
      'impactHint',
      'impactNoneHint',
      'impactNegativeWarning',
      'impactColCode',
      'impactColRecords',
      'impactColDays',
      'impactColBefore',
      'impactColAfter',
      'impactPooledFrom',
      'impactNegativeFlag',
    ] as const) {
      for (const [loc, cat] of Object.entries(CATALOGUES)) {
        expect(typeof getPath(cat, `admin.leaveHistoryImport.${key}`), `${loc} ${key}`).toBe('string');
      }
    }
  });

  it('both server actions take the answer EXPLICITLY, so it cannot be reached by omission', () => {
    const src = read(ACTIONS);
    expect(src).toMatch(/validateLeaveHistoryImportAction\(\s*csv: string,\s*openingBalancesAreNet: boolean,/);
    expect(src).toMatch(/openingBalancesAreNet: boolean,/);
    expect(src).toContain('validateLeaveHistoryImport(s, { records, openingBalancesAreNet })');
    expect(src).toContain('commitLeaveHistoryImport(s, { records, source, openingBalancesAreNet })');
    // The balance screens are server-rendered, so a run that deducted has to invalidate them too.
    expect(src).toContain("revalidatePath('/leave/employee-balances')");
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
