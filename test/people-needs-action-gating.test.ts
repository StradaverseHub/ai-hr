/**
 * r307 — WHO MAY SEE WHAT IS MISSING FROM SOMEBODY'S RECORD.
 *
 * /personnel is `scopedSession`: every employee browses colleagues there. The readiness column added in
 * r307 is a different kind of fact — "no bank account on record", "no tax number" — and while it prints
 * an ABSENCE rather than a value, it is still an admin-visible detail of somebody's record, which is why
 * /control-tower/readiness is admin-gated outright. So on this screen the column, the chip and the panel
 * are gated on `isAdmin`, and the two reads behind them are not issued for anybody else: a non-admin
 * must not pay for a query whose result they may not see, and a future refactor must not be able to
 * render the column by accident.
 *
 * WHY SOURCE SHAPE. A Next server component cannot be rendered in this project (it awaits
 * `scopedSession` and next-intl's request context), so the claim is pinned where it lives — in the
 * page's text. The repo makes this trade deliberately elsewhere (test/header-command-bar.test.ts,
 * test/leave-pack-drift.test.ts); it is recorded here rather than hidden, and the behaviour underneath
 * is covered by test/people-needs-action.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const PAGE = read('app/personnel/page.tsx');
const CELL = read('app/personnel/needs-action-cell.tsx');

/**
 * Source with comments removed.
 *
 * The "no values" assertion below is about what the component CAN RENDER, and a file that documents
 * "there is no salary here" would fail an assertion made over its prose — which is how a guard comes to
 * be about wording rather than behaviour. (The pack-drift ratchet has the same hazard from the other
 * direction: it reads comments, so a quoted import specifier in one trips it.)
 */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CELL_CODE = code(CELL);

describe('the readiness column is admin-only', () => {
  it('resolves the admin flag from lib/authz, not from a role string comparison', () => {
    expect(PAGE).toContain("import { isAdmin } from '@/lib/authz'");
    expect(PAGE).toMatch(/const admin = isAdmin\(session\)/);
  });

  it('issues NEITHER readiness read for a non-admin', () => {
    // employmentIdsWithGaps: guarded by a conditional on `admin`, not called then filtered.
    expect(PAGE).toMatch(/const gapIds = admin \? await employmentIdsWithGaps\(session\) : null/);
    // gapsForEmployments: same, with an empty Map as the non-admin value.
    expect(PAGE).toMatch(/admin\s*\?\s*await gapsForEmployments\(/);
    // And no unconditional call to either.
    for (const fn of ['employmentIdsWithGaps(', 'gapsForEmployments(']) {
      const calls = PAGE.split(fn).length - 1;
      // one import mention + one guarded call each
      expect(calls, `${fn} appears ${calls} times`).toBeLessThanOrEqual(2);
    }
  });

  it('renders the chip, the column header and the cell only inside an admin branch', () => {
    expect(PAGE).toMatch(/\{admin && \(\s*<div className="flex flex-wrap items-center gap-2">/);
    expect(PAGE).toMatch(/\{admin && <th[^>]*>\{t\('colNeeded'\)\}<\/th>\}/);
    expect(PAGE).toMatch(/\{admin &&\s*\(\(\) => \{/);
  });

  it('honours the chip only for an admin, so the URL cannot switch on the view for anybody else', () => {
    expect(PAGE).toMatch(/const needsView = admin && sp\.needs === '1'/);
  });

  it('keeps the chip in the pager links, so page 2 is still the same view', () => {
    expect(PAGE).toMatch(/\.\.\.\(needsView \? \{ needs: '1' \} : \{\}\)/);
  });

  it('widens the empty-state colspan with the column, so the empty row still spans the table', () => {
    expect(PAGE).toMatch(/colSpan=\{admin \? 7 : 6\}/);
  });
});

describe('the panel shows absences, never values', () => {
  it('names no salary, no account number and no identifier field', () => {
    // The payload type is what bounds this: if a value-bearing field is ever added, it shows up here.
    for (const forbidden of [
      'basicSalary',
      'salary',
      'bankAccountNo',
      'icNumber',
      'passportNumber',
      'taxNumber',
      'epfNumber',
      'socsoNumber',
    ]) {
      expect(CELL_CODE, `the panel must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('writes nothing — the one action is a link to the record screen', () => {
    expect(CELL_CODE).not.toMatch(/use(FormState|ActionState)|action=\{/);
    expect(CELL).toMatch(/href=\{`\/admin\/personnel\/\$\{person\.employmentId\}`\}/);
  });

  it('takes every string already resolved, so the island holds no dynamic t() key', () => {
    expect(CELL_CODE).not.toContain('useTranslations');
    expect(CELL_CODE).not.toMatch(/t\(`/);
  });

  it('lifts its button above the row-link overlay, or the click would open the record instead', () => {
    // 420ebab5 covers the whole row with a link overlay; the cell button must sit above it.
    expect(CELL).toMatch(/className="relative z-10/);
  });
});
