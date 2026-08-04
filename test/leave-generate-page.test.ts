/**
 * Remove Leave Year Configuration, and give entitlement generation a real home (feedback 4b0e76ae).
 *
 * Source-static, deliberately. What this item can get wrong is not arithmetic — it is REACHABILITY and
 * COMPLETENESS, and both are visible in the source: a page nobody registered, a tab nobody added, an action
 * with no caller, a section deleted from the panel but still passed as a prop, a locale file edited by line
 * range instead of by key. None of that is visible to a behaviour test, and one of them (a sweep with no
 * caller) would surface only at year end. test/leave-year-config.test.ts covers the runtime half.
 *
 * THE ONE-CALLER GUARD IS THE POINT OF THIS FILE. `openLeaveYearAction` is the only route to `openLeaveYear`,
 * which is the only thing in the system that posts a leave year's entitlement. Before this item it had ZERO
 * direct callers — it was reached through setLeaveYearStatusAction's draft→open transition inside the very
 * section this item deletes. Losing its last caller is a silent year-end failure, discovered in January.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { leavePack } from '../packs/leave';

import { SCREENS } from '../lib/permissions';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const GENERATE_ROUTE = '/admin/leave/generate';
const GENERATE_PAGE = 'app/admin/leave/generate/page.tsx';
const ACTIONS = 'app/admin/actions.ts';

const LOCALES = ['en', 'zh', 'ms', 'ta', 'th', 'vi'] as const;
const msgs = (loc: string) => JSON.parse(read(`messages/${loc}.json`));

/** Source lines with the comment lines dropped, so a reference *in prose* never counts as a call site.
 *  This file's own assertions are about code, and every one of the three surviving prose mentions of
 *  openLeaveYearAction (the redirect-const doc, the LEAVE-const note, the runToilExpiry precedent note)
 *  is a comment. */
function codeLines(src: string): string[] {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every non-test source file that mentions `needle` in CODE, as repo-relative paths. */
function codeReferences(needle: string): string[] {
  const hits: string[] = [];
  for (const dir of ['app', 'components', 'core', 'db', 'lib', 'localization', 'packs', 'scripts']) {
    for (const file of walk(resolve(ROOT, dir))) {
      if (codeLines(readFileSync(file, 'utf8')).some((l) => l.includes(needle))) {
        hits.push(relative(ROOT, file));
      }
    }
  }
  return hits.sort();
}

describe('4b0e76ae · the Generate Entitlement page is REACHABLE', () => {
  it('the page exists and is guarded with requireAdmin', () => {
    expect(existsSync(resolve(ROOT, GENERATE_PAGE))).toBe(true);
    const page = read(GENERATE_PAGE);
    // requireAdmin() is also what registers the route with test/function-access.test.ts's GUARD_RE scan.
    expect(page).toContain('requireAdmin()');
    // 645e67c4 — the page no longer marks itself as an active TAB: Leave config is a sidebar fly-out and
    // the strip is deleted. Reachability is asserted against the pack node below, where it now lives.
    expect(page).not.toContain('LeaveTabs');
  });

  it('THE TWO HALVES CANNOT DRIFT: the route is in lib/permissions.ts AND in the leave fly-out node', () => {
    // Either half alone ships a broken feature: no permissions row ⇒ our own access check refuses the page
    // (and test/function-access.test.ts fails); no tab ⇒ nobody can find it. They are asserted together on
    // purpose, so a later edit that removes one is caught by the same test that guards the other.
    const leaveConfig = SCREENS.find((s) => s.screenKey === 'leaveConfig');
    expect(leaveConfig, 'the leaveConfig screen must still exist').toBeTruthy();
    expect(leaveConfig!.routes).toContain(GENERATE_ROUTE);
    // It is a ROUTE on the existing screenKey, not a new screenKey — same admin surface, same guard (the
    // /admin/leave/replacement precedent documented in place).
    expect(leaveConfig!.guard).toBe('requireAdmin');
    expect(SCREENS.filter((s) => s.routes.includes(GENERATE_ROUTE))).toHaveLength(1);

    // 645e67c4 — the navigation half moved from the tab strip to the leave pack's fly-out node. The
    // promise is unchanged and is the whole point of this test: no permissions row and our own access
    // check refuses the page; no menu entry and nobody can find it.
    const node = leavePack.navNodes!.find((n) => n.group === 'admin')!;
    expect(node.children.map((c) => c.href)).toContain(GENERATE_ROUTE);
  });

  it('the menu label exists under nav in all six locales', () => {
    // 645e67c4 — moved from admin.leaveTabs.generate to nav.leaveGenerate with the strip's retirement.
    for (const loc of LOCALES) {
      const label = (msgs(loc)?.nav ?? {}).leaveGenerate;
      expect(typeof label, `${loc} nav.leaveGenerate`).toBe('string');
      expect(String(label).length, `${loc} nav.leaveGenerate is blank`).toBeGreaterThan(0);
    }
  });

  it('the page re-uses admin.leave.yearLabel rather than minting a second year label', () => {
    // yearLabel sits inside the span an earlier revision named for deletion; it is KEPT for exactly this.
    expect(read(GENERATE_PAGE)).toContain("t('yearLabel')");
    for (const loc of LOCALES) {
      expect(typeof msgs(loc)?.admin?.leave?.yearLabel, `${loc} admin.leave.yearLabel`).toBe('string');
    }
  });

  it('the page is a SERVER component passing no function props across a client boundary', () => {
    // The r123 defect (test/server-client-boundary.test.ts) threw at RENDER and no gate step caught it.
    // The cheapest defence is not mounting a client component at all: a plain form posting to the action.
    const page = read(GENERATE_PAGE);
    expect(page.includes("'use client'")).toBe(false);
    expect(page).toContain('<form action={openLeaveYearAction}');
  });
});

describe('4b0e76ae · openLeaveYearAction has EXACTLY ONE caller', () => {
  it('is defined once, in app/admin/actions.ts', () => {
    const actions = read(ACTIONS);
    expect(actions.match(/export async function openLeaveYearAction/g)).toHaveLength(1);
  });

  it('is called from the Generate page and NOWHERE else (the r106 lesson)', () => {
    const callers = codeReferences('openLeaveYearAction').filter((f) => f !== ACTIONS);
    expect(callers, `expected only ${GENERATE_PAGE} to reach the grant sweep`).toEqual([GENERATE_PAGE]);
  });

  it('is ADMIN-gated — requireAdmin(), never getSession()', () => {
    // Until this item it opened with getSession(); openLeaveYear asserts nothing about admin and
    // leave_ledger RLS gates on can_see_employment, so an ordinary member POSTing it would have granted
    // accruals across every employment they can see. The runtime half of this is in
    // test/leave-year-config.test.ts, which fails if the guard is reverted.
    const actions = read(ACTIONS);
    const body = actions.slice(actions.indexOf('export async function openLeaveYearAction'));
    const firstBody = body.slice(0, body.indexOf('\n}\n'));
    expect(firstBody).toContain('await requireAdmin()');
    expect(firstBody.includes('getSession()')).toBe(false);
  });
});

describe('4b0e76ae · the Leave Year Configuration block is GONE from Custom Settings', () => {
  const panel = () => read('components/leave-type-panel.tsx');
  const entitlements = () => read('app/admin/leave/entitlements/page.tsx');

  it('the panel no longer declares, destructures or renders the leaveYearSection slot', () => {
    const src = panel();
    expect(src.includes('leaveYearSection?: ReactNode;')).toBe(false);
    expect(src.includes('{leaveYearSection}')).toBe(false);
    expect(src.includes("t('leaveYearConfigTitle')")).toBe(false);
  });

  it('the Entitlements page composes no leave-year section and passes no slot', () => {
    // Comment lines are stripped first: the page's own header still NAMES the two deleted reads, to say
    // what went and why. Prose about a removal is not the removal failing.
    const src = codeLines(entitlements()).join('\n');
    expect(src.includes('const leaveYearSection')).toBe(false);
    expect(src.includes('leaveYearSection={')).toBe(false);
    expect(src.includes('listLeaveYearConfigs')).toBe(false);
    expect(src.includes('leaveYearsWithRecords')).toBe(false);
  });

  it('both leave-year dialogs are deleted (they had no other call site)', () => {
    expect(existsSync(resolve(ROOT, 'components/leave/leave-year-rule-dialog.tsx'))).toBe(false);
    expect(existsSync(resolve(ROOT, 'components/leave/leave-year-edit-dialog.tsx'))).toBe(false);
  });

  it('the four writing actions are gone; only the grant sweep survives', () => {
    const actions = read(ACTIONS);
    for (const gone of [
      'upsertLeaveYearConfigAction',
      'setLeaveYearStatusAction',
      'saveFutureOpeningRuleAction',
      'deleteLeaveYearAction',
    ]) {
      expect(codeLines(actions).some((l) => l.includes(gone)), `${gone} must be gone`).toBe(false);
    }
  });

  it('the eight leave-year config services are gone from core/leave.ts', () => {
    const core = codeLines(read('core/leave.ts')).join('\n');
    for (const gone of [
      'listLeaveYearConfigs',
      'leaveYearsWithRecords',
      'upsertLeaveYearConfig',
      'setLeaveYearStatus',
      'saveFutureOpeningRule',
      'computeOpenLeaveYearDate',
      'deleteLeaveYear',
      'LeaveYearDeleteError',
      'leaveYearOpenForApplication',
    ]) {
      expect(core.includes(gone), `${gone} must be gone from core/leave.ts`).toBe(false);
    }
  });

  it('requestLeave keeps the future-year gate but no longer READS leave_year_config', () => {
    const core = read('core/leave.ts');
    // The behaviour stays — deleting it would let an employee book next-year dates against this year's
    // balance, which moves carry-forward and forfeit. Only the SELECT went.
    expect(core).toContain('throw new LeaveYearNotOpenError(targetLeaveYear)');
    expect(core).toContain('export class LeaveYearNotOpenError');
    expect(codeLines(core).some((l) => l.includes('leaveYearConfig')), 'no leaveYearConfig read may remain').toBe(false);
  });
});

describe('4b0e76ae · i18n was edited BY KEY, not by line range', () => {
  const REMOVED = [
    'leaveYearTitle', 'leaveYearConfigTitle', 'leaveYearHelp', 'openLeaveYear', 'leaveYearStatus_draft',
    'leaveYearStatus_open', 'leaveYearStatus_closed', 'openLeaveYearDateLabel',
    'employeeApplicationStartDateLabel', 'addLeaveYear', 'deleteLeaveYear', 'deleteLeaveYearConfirmTitle',
    'deleteLeaveYearConfirmBody', 'deleteLeaveYearTarget', 'deleteLeaveYearWarning',
    'deleteLeaveYearReasonLegend', 'deleteLeaveYearReasonWronglyCreated', 'deleteLeaveYearReasonDuplicate',
    'deleteLeaveYearConfirmButton', 'deleteLeaveYearYes', 'deleteLeaveYearNo', 'deleteLeaveYearBlockedOpened',
    'deleteLeaveYearBlockedRecords', 'deleteLeaveYearBlockedRequests', 'deleteLeaveYearNotFound',
    'leaveYearSavedToast', 'closeLeaveYear', 'reopenLeaveYear', 'noLeaveYears', 'leaveYearAdvancedTitle',
    'editLeaveYearTitle', 'leaveYearAdvancedHelp', 'openingRuleTitle', 'openingRuleHelp',
    'openingRuleEnableLabel', 'openBeforeAmountLabel', 'openBeforeUnitLabel', 'openingUnitDays',
    'openingUnitWeeks', 'openingUnitMonths', 'openingRuleSummary',
  ];

  it('removes all 41 keys under admin.leave in every locale', () => {
    expect(REMOVED).toHaveLength(41);
    for (const loc of LOCALES) {
      const leave = msgs(loc)?.admin?.leave ?? {};
      const survivors = REMOVED.filter((k) => k in leave);
      expect(survivors, `${loc} still carries: ${survivors.join(', ')}`).toEqual([]);
    }
  });

  it('KEEPS the survivors that sit inside the deleted span in zh/ms/ta/th/vi', () => {
    // In every non-en locale the deleted keys are SPLIT into two distant blocks, and earnedScopeLeaveYear —
    // the Run Earned Accrual card's own scope label — sits inside the span an earlier revision named for
    // deletion. A line-range delete in any of those files breaks that card and orphans 37 keys.
    for (const loc of LOCALES) {
      const leave = msgs(loc)?.admin?.leave ?? {};
      expect(typeof leave.yearLabel, `${loc} admin.leave.yearLabel`).toBe('string');
      expect(typeof leave.earnedScopeLeaveYear, `${loc} admin.leave.earnedScopeLeaveYear`).toBe('string');
    }
  });

  it('does NOT touch leave.errors.leaveYearNotOpen (the gate stays) or leaveYearApplicationLimit', () => {
    // leaveYearApplicationLimit is a DIFFERENT feature that merely shares a name prefix — deleting it by
    // prefix match is the obvious way to break this.
    for (const loc of LOCALES) {
      const errors = msgs(loc)?.leave?.errors ?? {};
      expect(typeof errors.leaveYearNotOpen, `${loc} leave.errors.leaveYearNotOpen`).toBe('string');
      expect(typeof errors.leaveYearApplicationLimit, `${loc} leave.errors.leaveYearApplicationLimit`).toBe('string');
    }
  });

  it('carries the new Generate page copy in all six locales', () => {
    for (const loc of LOCALES) {
      const leave = msgs(loc)?.admin?.leave ?? {};
      for (const key of ['generateTitle', 'generateHelp', 'generateButton', 'generateToast']) {
        expect(typeof leave[key], `${loc} admin.leave.${key}`).toBe('string');
      }
      // The toast interpolates the counts the reporter asked to see.
      expect(String(leave.generateToast)).toContain('{granted}');
    }
  });
});

describe('4b0e76ae · the reset keeps the table, and the year list stops reading it', () => {
  it('migration 0385 deletes every leave_year_config row and is JOURNALLED', () => {
    const sql = read('db/migrations/0385_leave_year_config_reset.sql');
    expect(sql).toMatch(/DELETE FROM leave_year_config;/);
    // A migration file is not a migration until it is journalled — drizzle records a `when` watermark and
    // SILENTLY SKIPS anything below it.
    const journal = JSON.parse(read('db/migrations/meta/_journal.json'));
    const entry = journal.entries.find((e: { tag: string }) => e.tag === '0385_leave_year_config_reset');
    expect(entry, '0385 must be journalled or drizzle skips it').toBeTruthy();
    const maxOther = Math.max(
      ...journal.entries.filter((e: { tag: string }) => e.tag !== entry.tag).map((e: { when: number }) => e.when),
    );
    expect(entry.when).toBeGreaterThan(maxOther);
  });

  it('the table and its pack satellite row stay — only the note text is corrected', () => {
    // test/harness.ts and test/leave-pack.test.ts both still expect the table to exist; the redesigned
    // Leave Year module picks its own shape, and dropping now buys nothing but risk.
    expect(read('db/schema.ts')).toContain("pgTable(\n  'leave_year_config'");
    const pack = read('packs/leave/index.ts');
    expect(pack).toContain("table: 'leave_year_config'");
    // The old note was wrong on two counts: the table is TENANT-wide, not per-company, and the cycle
    // override moved onto the leave type (4d6eae7b).
    expect(pack.includes('per-company leave-year cycle')).toBe(false);
  });

  it('the Run Earned Accrual selector now offers the shared computed range', () => {
    const page = read('app/admin/leave/entitlements/page.tsx');
    expect(page).toContain('entitlementYearOptions(currentYear)');
    expect(page).toContain('leaveYears={earnedLeaveYears}');
    // The old fallback array built currentYear..+6 with no past years.
    expect(page.includes('Array.from({ length: 7 }')).toBe(false);
  });
});
