/**
 * db55d08a (r369) — THE LEAVE B/F DATA IMPORT SCREEN, and the keys the coverage guard cannot see.
 *
 * `test/i18n-coverage.test.ts` check C only resolves LITERAL `t('a.b')` keys in single-namespace files.
 * FOUR key families on this screen are computed, so they are invisible to it and would ship as raw
 * `admin.leaveBfImport.mode.replace.label` text behind a green everything:
 *
 *   · the six step labels, rendered as `` t(`step.${s}`) `` over LEAVE_BF_STEPS;
 *   · the upload-failure messages, resolved through `importFileMessageKey(e)` — the same computed-key
 *     hazard test/employee-import-file.test.ts pins for the employee importer;
 *   · the import-mode labels, hints and short names, `` t(`mode.${m}.label`) `` over LEAVE_BF_IMPORT_MODES;
 *   · the preview's mode readout, `` t(`modeReadout.${preview.mode}`) ``.
 *
 * All four are pinned here, in all six catalogues, with the untranslated-copy check the r266 §E guard
 * uses. The rest of the file is the screen's shape: the three registries agree, the page is a server
 * component that reads its heading through the row helper, and the reporter's six steps are in order.
 *
 * ⚠️ AND ONE THING THAT IS NOT ABOUT THE SCREEN AT ALL: the ENTRY TYPE. `LEAVE_BF_ENTRY_TYPE` is pinned
 * as a source-level fact here as well as behaviourally in test/leave-bf-import.test.ts, because the
 * constant is the only place the entry type is named and a service that had quietly stopped reading it
 * would otherwise be caught only by the DB case. See core/leave-bf-import.ts's header for what an
 * `accrual` here costs: a whole year's entitlement, silently.
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
  LEAVE_BF_COLUMNS,
  LEAVE_BF_ENTRY_TYPE,
  LEAVE_BF_IMPORT_MODES,
  LEAVE_BF_REQUIRED_KEYS,
  LEAVE_BF_STEPS,
  canonicalBfColumnKey,
  leaveBfRunOutcome,
  resolveLeaveBfImportOptions,
} from '../lib/leave-bf-import-schema';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CATALOGUES = { en, ms, ta, th, vi: vi_, zh } as const;
type Dict = Record<string, unknown>;
const getPath = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);

const HREF = '/admin/leave-config/bf-import';
const PAGE = 'app/admin/leave-config/bf-import/page.tsx';
const ISLAND = 'app/admin/leave-config/bf-import/leave-bf-import.tsx';
const ACTIONS = 'app/admin/leave-config/bf-import/actions.ts';
const SERVICE = 'core/leave-bf-import.ts';
const CONTRACT = 'lib/leave-bf-import-schema.ts';
const MIGRATION = 'db/migrations/0497_leave_bf_import.sql';

// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('db55d08a — the entry type, pinned in the source as well as in the database', () => {
  it('the contract names the entry type ONCE, and it is adjustment', () => {
    expect(LEAVE_BF_ENTRY_TYPE).toBe('adjustment');
    // Not 'accrual', and this is not a tautology beside the line above: it is the claim a future editor
    // has to consciously break, next to the comment that says what breaking it costs.
    expect(LEAVE_BF_ENTRY_TYPE).not.toBe('accrual');
  });

  it('the service writes the constant and never a literal entry type of its own', () => {
    const src = read(SERVICE);
    // Every insert reads the constant. A literal would be a second place the entry type is decided, which
    // is exactly how one of them comes to say 'accrual'.
    expect(src).toContain('entryType: LEAVE_BF_ENTRY_TYPE');
    // The stripped source must carry no literal 'accrual' write. Comments DO discuss it at length — the
    // hazard is the point of the module — so they are removed before the claim is made, the way
    // test/function-access.test.ts strips comments before classifying.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/entryType:\s*'accrual'/);
    expect(code).not.toMatch(/entry_type\s*=\s*'accrual'/);
  });

  it('the migration confines the run-id column to adjustment rows, and GRANTs on the table it creates', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS leave_bf_import_run');
    // CLAUDE.md §6: a migration that CREATEs a table must GRANT on it — a dev restore has no default
    // privileges and the suite connects as the OWNER, so an omitted GRANT is invisible to every test.
    expect(sql).toMatch(/GRANT [^;]*ON leave_bf_import_run TO ai_hr_app/);
    expect(sql).toContain('ALTER TABLE leave_bf_import_run ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('app.is_admin()');
    expect(sql).toContain("CHECK (bf_import_run_id IS NULL OR entry_type = 'adjustment')");
    expect(sql).toContain("CHECK (import_mode IN ('replace', 'add'))");
  });

  it('the migration is in the journal, and its idx came from max(idx) rather than entries.length', () => {
    const journal = JSON.parse(read('db/migrations/meta/_journal.json')) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const mine = journal.entries.find((e) => e.tag === '0497_leave_bf_import');
    // The journal IS the migration: a .sql without an entry never runs (CLAUDE.md §6).
    expect(mine, 'migration 0497 must be journalled').toBeDefined();
    expect(mine!.idx).toBe(497);
    // ⚠️ THE SILENT-SKIP GUARD — RE-POINTED IN r375 FROM A POSITION TO THE INVARIANT.
    //
    // It used to assert that this entry was the newest in the journal by BOTH idx and `when`:
    //     expect(Math.max(...journal.entries.map((e) => e.idx))).toBe(mine!.idx);
    //     expect(Math.max(...journal.entries.map((e) => e.when))).toBe(mine!.when);
    // Both were true the day they were written and expired the moment ANY later round added a
    // migration — r375's 0498 did, and this case failed with `expected 498 to be 497`. "Mine is the
    // global maximum" is a position, not the property the comment is about (CLAUDE.md §8: pin
    // invariants, not positions).
    //
    // The actual hazard: drizzle's watermark is the last applied `when`, so an entry whose `when` is
    // EARLIER than an already-applied one is skipped at exit 0 — no error, no row. The invariant that
    // makes THIS entry safe, and that stays true however many migrations follow, is ordering relative
    // to its neighbours rather than to the end of the list.
    const byIdx = [...journal.entries].sort((a, b) => a.idx - b.idx);
    for (const e of byIdx.filter((x) => x.idx < mine!.idx)) {
      expect(
        e.when,
        `idx ${e.idx} (${e.tag}) is dated at or after 0497 — drizzle would reach 0497's watermark first and SKIP it`,
      ).toBeLessThan(mine!.when);
    }
    for (const e of byIdx.filter((x) => x.idx > mine!.idx)) {
      expect(
        e.when,
        `idx ${e.idx} (${e.tag}) is numbered after 0497 but dated before it — it would be SKIPPED at exit 0`,
      ).toBeGreaterThan(mine!.when);
    }
    // ⚠️ DELIBERATELY NOT asserted globally across every pair, because the journal ALREADY contains one
    // such inversion and this guard is not the place to fail on it: idx 230 is dated 1781862229000 and
    // idx 240 is dated 1781862219000 — ten seconds EARLIER despite the higher number. Both were applied
    // long ago so the watermark has passed them and it is inert, but it is real, and it is why this
    // case checks the neighbourhood of one entry rather than the whole file.
    // …and `entries.length` is NOT the allocator: the two have diverged by dozens, and a number taken
    // from the length would be a low number, which is a silent skip.
    expect(journal.entries.length).not.toBe(mine!.idx);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('db55d08a — the three registries agree about the new row', () => {
  it('the fly-out row, the map group and the permission route all name the same address', () => {
    const children = leavePack.navNodes!.find((n) => n.group === 'admin')!.children;
    const row = children.find((c) => c.href === HREF);
    expect(row, 'the Leave Config fly-out must carry the row').toBeTruthy();
    expect(row!.labelKey).toBe('leaveBfImport');
    // One page, no tabs, no sub-screen — so nothing for the row to stay lit on beyond its own href.
    expect(row!.ownedSubpaths ?? []).toEqual([]);
    // Not module-gated: leave is core (Leave Credit is the only gated row of this node).
    expect(row!.adminOnly).toBeUndefined();
    expect(row!.managerUp).toBeUndefined();

    const group = LEAVE_CONFIG_MAP.find((g) => g.navKey === 'leaveBfImport')!;
    expect(group, 'every Leave Config row is a group; this one must be too').toBeTruthy();
    expect(group.items.map((i) => i.href)).toEqual([HREF]);
    // A GROUP OF ONE, so no tab strip is drawn. A second item here would be the wrong shape twice over:
    // see the entry in components/leave-config-map.tsx.
    expect(group.items).toHaveLength(1);

    expect(REGISTERED_ROUTES.has(HREF)).toBe(true);
    const owner = SCREENS.find((s) => s.routes.includes(HREF))!;
    // The EXISTING key, never a new one: a screenKey may key stored role configs, so minting one for a
    // sibling of the two importers beside it would create a permission nobody has been granted.
    expect(owner.screenKey).toBe('leaveConfig');
    expect(owner.guard).toBe('requireAdmin');
  });

  it('it sits immediately after the RECORD importer — balances, then records, then the opening figure', () => {
    const labels = leavePack.navNodes!.find((n) => n.group === 'admin')!.children.map((c) => c.labelKey);
    expect(labels[labels.indexOf('leaveHistoryImport') + 1]).toBe('leaveBfImport');
    // …and the same order in the map, which is what test/r266 asserts both ways.
    const ids = LEAVE_CONFIG_MAP.map((g) => g.id);
    expect(ids[ids.indexOf('leaveHistoryImport') + 1]).toBe('leaveBfImport');
  });

  it('neither sibling importer was touched: same ids, same routes, same labels', () => {
    // The plan promises the existing screens are not changed at all. Pinned, because "I only added a row"
    // is exactly the claim that turns out to have moved something.
    const balanceTab = LEAVE_CONFIG_MAP.flatMap((g) => g.items).find((i) => i.id === 'importLeaveData')!;
    expect(balanceTab.href).toBe('/admin/leave-config/import');
    expect(en.admin.leaveConfigMap.item.importLeaveData).toBe('Leave Balance Import');
    const record = LEAVE_CONFIG_MAP.flatMap((g) => g.items).find((i) => i.id === 'leaveHistoryImport')!;
    expect(record.href).toBe('/admin/leave-config/history-import');
    expect(en.admin.leaveConfigMap.item.leaveHistoryImport).toBe('Leave History Data Import');
    const leaveConfig = SCREENS.find((s) => s.screenKey === 'leaveConfig')!;
    for (const r of ['/admin/leave-config/import', '/admin/leave-config/history-import', HREF]) {
      expect(leaveConfig.routes, r).toContain(r);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('db55d08a — the page is the house shape', () => {
  it('server component, guarded, heading through the row helper, map mounted once', () => {
    const src = read(PAGE);
    expect(src).toContain('requireAdmin()');
    expect(src).toContain("leaveConfigPageHeader('leaveBfImport')");
    expect(src.match(/<LeaveConfigMap current="leaveBfImport" \/>/g)).toHaveLength(1);
    // Not a client component, and it must stay one — the r123 class test/server-client-boundary pins.
    expect(src.startsWith("'use client'")).toBe(false);
    // The log is read on the SERVER so it is RLS-scoped, not fetched from the island.
    expect(src).toContain('listLeaveBfImportRuns(s)');
    // The heading is NOT the tab label (the mismatch r266 measured across four screens).
    const headerBlock = src.slice(src.indexOf('<PageHeader'), src.indexOf('/>', src.indexOf('<PageHeader')));
    expect(headerBlock).not.toContain('leaveConfigScreenTitle(');
  });

  it('all THREE server actions are behind requireAdmin — the rollback moves days too', () => {
    const src = read(ACTIONS);
    expect(src).toContain("'use server'");
    // Three, not two: the rollback writes compensating ledger rows and is as much a money path as the
    // commit. An action added later without a guard makes this count disagree.
    expect(src.match(/await requireAdmin\(\)/g) ?? []).toHaveLength(3);
    // The server receives TEXT and re-parses it: no workbook ever reaches a server action.
    expect(src).toContain('parseCsvRecords(csv)');
    expect(src).not.toMatch(/workbookToCsv|buildXlsx/);
    // The balance surfaces are revalidated after a write — they are server-rendered and cached, and the
    // employee's own My Leave is the screen the reporter's spot-check compares against.
    for (const p of ['/leave/employee-balances', '/me', HREF]) {
      expect(src, p).toContain(`revalidatePath('${p}')`);
    }
  });

  it('the island reads the file in the BROWSER, through the one decoder this repo has', () => {
    const src = read(ISLAND);
    expect(src.startsWith("'use client'")).toBe(true);
    expect(src).toContain("from '@/lib/import-file'");
    expect(src).toContain('readImportFile(file)');
    // …and the xlsx template is built in the browser, so no spreadsheet library ships to the server.
    expect(src).toContain("await import('@/lib/spreadsheet')");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('db55d08a — the contract, and the computed keys the coverage guard cannot see', () => {
  it('the reporter’s six steps, in the reporter’s order, and every label in all six locales', () => {
    expect(LEAVE_BF_STEPS).toEqual([
      'downloadTemplate',
      'uploadExcel',
      'validate',
      'previewResults',
      'confirmImport',
      'importSummary',
    ]);
    for (const s of LEAVE_BF_STEPS) {
      // COMPUTED as `` t(`step.${s}`) ``, so check C cannot see it.
      const key = `admin.leaveBfImport.step.${s}`;
      const enValue = getPath(en, key);
      expect(typeof enValue, key).toBe('string');
      for (const [loc, cat] of Object.entries(CATALOGUES)) {
        const v = getPath(cat, key);
        expect(typeof v, `${loc} ${key}`).toBe('string');
      }
    }
  });

  it('the two import modes carry a label, a hint and a short name in all six locales', () => {
    expect(LEAVE_BF_IMPORT_MODES).toEqual(['replace', 'add']);
    // Replace FIRST and Replace as the default: the reporter's own recommended default, resolved in ONE
    // place so the screen and the server cannot disagree about it.
    expect(resolveLeaveBfImportOptions().mode).toBe('replace');
    expect(resolveLeaveBfImportOptions({}).mode).toBe('replace');
    expect(resolveLeaveBfImportOptions({ mode: 'add' }).mode).toBe('add');
    for (const m of LEAVE_BF_IMPORT_MODES) {
      for (const leaf of ['label', 'hint', 'short'] as const) {
        // COMPUTED as `` t(`mode.${m}.${leaf}`) ``.
        const key = `admin.leaveBfImport.mode.${m}.${leaf}`;
        for (const [loc, cat] of Object.entries(CATALOGUES)) {
          expect(typeof getPath(cat, key), `${loc} ${key}`).toBe('string');
        }
      }
      // COMPUTED as `` t(`modeReadout.${preview.mode}`) `` — the SERVER's own resolution, echoed back.
      const readout = `admin.leaveBfImport.modeReadout.${m}`;
      for (const [loc, cat] of Object.entries(CATALOGUES)) {
        expect(typeof getPath(cat, readout), `${loc} ${readout}`).toBe('string');
      }
    }
    // The hint under Replace has to say what it does NOT do, or the reader is surprised by the one thing
    // the mode deliberately leaves alone.
    expect(en.admin.leaveBfImport.mode.replace.hint).toMatch(/previous B\/F import/);
  });

  it('every upload-failure message resolves — the computed importFileMessageKey family', () => {
    for (const key of Object.values(IMPORT_FILE_MESSAGE_KEYS)) {
      const full = `admin.leaveBfImport.${key}`;
      for (const [loc, cat] of Object.entries(CATALOGUES)) {
        expect(typeof getPath(cat, full), `${loc} ${full}`).toBe('string');
      }
    }
  });

  it('the five columns are the reporter’s, and B/F Expiry Date is deliberately absent', () => {
    expect(LEAVE_BF_COLUMNS.map((c) => c.header)).toEqual([
      'Employee ID',
      'Leave Code',
      'Entitlement Year',
      'B/F Days',
      'Remark',
    ]);
    // Entitlement Year is REQUIRED here, unlike the record importer's: there is no start date to infer it
    // from, and it is the only thing that says which leave year this figure opens.
    expect(LEAVE_BF_REQUIRED_KEYS).toEqual(['employee_id', 'leave_code', 'entitlement_year', 'bf_days']);
    // The dropped column, pinned as ABSENT so a later "helpful" addition has to argue with this comment:
    // the leave type's own carry-forward expiry rule is the only rule, and there is no per-row column on a
    // ledger row to hold a per-line override. The approved plan states the exclusion to the reporter.
    expect(LEAVE_BF_COLUMNS.map((c) => c.key)).not.toContain('bf_expiry_date');
    // …and the slash in "B/F Days" survives parseCsvRecords, so the canonicaliser has to strip it.
    expect(canonicalBfColumnKey('b/f_days')).toBe('bf_days');
  });

  it('the outcome badge is derived from the counts, so it can never disagree with them', () => {
    expect(leaveBfRunOutcome({ importedRows: 3, failedRows: 0 })).toBe('succeeded');
    expect(leaveBfRunOutcome({ importedRows: 2, failedRows: 1 })).toBe('partial');
    expect(leaveBfRunOutcome({ importedRows: 0, failedRows: 3 })).toBe('failed');
    // A run that imported nothing because there was nothing to import is still a success: 0/0.
    expect(leaveBfRunOutcome({ importedRows: 0, failedRows: 0 })).toBe('succeeded');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('db55d08a — what the screen SAYS, and the sentences it must not borrow', () => {
  /** Every literal `t('…')` leaf the island reads, so a key renamed on one side fails here. */
  const LEAVES = (() => {
    const src = read(ISLAND);
    const out = new Set<string>();
    for (const m of src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) out.add(m[1]);
    return [...out].sort();
  })();

  it('every literal key the island renders exists in all six catalogues', () => {
    // Non-vacuity: the island really does render a couple of dozen literal keys, so an empty scrape would
    // make this case prove nothing.
    expect(LEAVES.length).toBeGreaterThan(40);
    for (const leaf of LEAVES) {
      const key = `admin.leaveBfImport.${leaf}`;
      for (const [loc, cat] of Object.entries(CATALOGUES)) {
        expect(typeof getPath(cat, key), `${loc} ${key}`).toBe('string');
      }
    }
  });

  it('the row description is its OWN sentence and borrows neither neighbour’s', () => {
    const mine = en.admin.leaveConfigBfImport.pageDescription;
    expect(typeof mine).toBe('string');
    expect(mine).not.toBe(en.admin.leaveConfigHistoryImport.pageDescription);
    expect(mine).not.toBe(en.admin.leaveConfigAdjustments.pageDescription);
    // ⚠️ PROSE OUTLIVES THE KERNEL. The two sentences this row must never be described by are "loads past
    // leave records" (it creates NONE) and "changes a balance by hand" (it states the figure a leave year
    // OPENS with). Both are asserted as ABSENT from this row's own sentence, because a copy-pasted
    // description is a screen telling an administrator the opposite of what the tool does.
    expect(mine).not.toMatch(/leave records/i);
    expect(mine).not.toMatch(/by hand/i);
    // What it must say instead: that no leave record is created, which is the difference from its neighbour.
    expect(mine).toMatch(/No leave record is created/i);
  });

  it('the year-meaning note is on the screen, because it is the thing users get wrong', () => {
    // The reporter asked for this in their own words: "Entitlement Year means the year the B/F goes into…
    // Put this in the template's instruction note, because users often confuse it."
    expect(en.admin.leaveBfImport.yearMeaning).toMatch(/2026 means days carried from 2025 into 2026/);
    expect(read(ISLAND)).toContain("t('yearMeaning')");
  });

  it('the go-live sequence is printed on the screen, in the reporter’s order', () => {
    const src = read(ISLAND);
    for (const k of ['sequenceTitle', 'sequence1', 'sequence2', 'sequence3', 'sequence4']) {
      expect(src, k).toContain(`t('${k}')`);
    }
    // Entitlements FIRST — loading B/F before they are generated risks the year-end carry rule trimming
    // the figure that was just loaded, which is a silent wrong number rather than an error.
    expect(en.admin.leaveBfImport.sequence1).toMatch(/entitlements first/i);
    expect(en.admin.leaveBfImport.sequence2).toMatch(/brought-forward/i);
  });

  it('the summary says no leave record was created, which is the difference from the row above', () => {
    expect(en.admin.leaveBfImport.resultNoRecord).toMatch(/No leave record was created/i);
    expect(read(ISLAND)).toContain("t('resultNoRecord')");
  });

  it('the preview shows the carry cap’s effect, in its own columns, above Confirm import', () => {
    const src = read(ISLAND);
    // The three figures the reader needs, as three columns: the raw figure, the capped figure the grid
    // prints, and the difference. One column would hide the cap, which is the surprise the plan promises
    // to remove.
    for (const k of ['impactColAfter', 'impactColCarried', 'impactColForfeited']) {
      expect(src, k).toContain(`t('${k}')`);
    }
    // …and it is rendered BEFORE the confirm button, which is the requirement rather than a preference.
    const impactAt = src.indexOf('<BalanceImpactSection preview={preview} />');
    const confirmAt = src.indexOf('onClick={onImport}');
    expect(impactAt).toBeGreaterThan(-1);
    expect(confirmAt).toBeGreaterThan(impactAt);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('db55d08a — what this round deliberately did NOT do', () => {
  it('the Leave Balance Import screen is untouched, and its narrow warning is NOT widened here', () => {
    /**
     * ⚠️ THIS IS A SCOPE GUARD, NOT A CORRECTNESS ONE, AND IT IS HERE ON PURPOSE.
     *
     * The same year-cancelling trap is live on the balance importer: its pre-existing-accrual warning only
     * looks for a row dated exactly 1 January (`month === 1 && day === 1`), which is NARROWER than
     * `yearOpenMarkerCond`, so a hand-entered accrual dated any other day in the year slips through
     * silently. The reporter was told that screen would not be edited, and it is its own item — widening
     * the warning would not even catch the damaging case, in which there is no pre-existing accrual at all.
     *
     * So the warning stays exactly as narrow as it is, and this case says so rather than leaving a future
     * reader to wonder whether it was forgotten. The day the sibling item ships, this case is UPDATED with
     * the old claim quoted — never deleted.
     */
    const src = read('core/leave-import.ts');
    expect(src).toMatch(/getUTCMonth\(\)|month/);
    // The balance importer still writes what the FILE says, not a fixed entry type: it is the tool where
    // the uploader states the entry type themselves, which is precisely why a B/F screen had to exist.
    expect(src).not.toContain('LEAVE_BF_ENTRY_TYPE');
    expect(src).not.toContain('bfImportRunId');
  });

  it('this round adds no per-line B/F expiry, and no second rule over the leave type’s own', () => {
    // The leave type's carry-forward expiry config remains the ONLY rule. Nothing in the new service reads
    // or writes an expiry, and nothing in the contract carries a column for one.
    const src = read(SERVICE);
    expect(src).not.toMatch(/carryForwardExpiry(Mode|Months|Month|Day)/);
    expect(read(CONTRACT)).not.toContain('bf_expiry_date');
  });

  it('this round changes no consumption ordering: nothing here reads or writes reconstructCarry', () => {
    // The reporter asked whether carried days are used up first. THE RULE, read before anything was
    // written: the ledger keeps one running balance and nothing on it is tagged carried-or-current; the
    // only place the two are told apart is the expiry forfeit's `unconsumedCarry = max(0, carried −
    // debitsInWindow)`, whose own comment calls it "a weaker rule: no ordering claim". This module assumes
    // no ordering and touches none of it.
    // Comments DISCUSS the ordering rule at length — stating the rule is the point of having read it —
    // so they are stripped before the claim is made, the way test/function-access.test.ts strips comments
    // before classifying a guard name.
    const src = read(SERVICE);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toContain('reconstructCarry');
    expect(code).not.toContain('resolveCarryBreakdown');
    // It DOES share the one arithmetic that decides how much carries, so the preview cannot promise a
    // figure openLeaveYear would not produce.
    expect(src).toContain('carryAllowanceFrom');
    expect(src).toContain('carryEnabled');
  });
});
