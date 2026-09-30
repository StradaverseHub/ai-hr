/**
 * Item e0b6e3b8, r367 — THE PAYSLIP'S TWO STATUTORY SECTIONS LOSE THEIR BRACKETS, AND ONE OF THE TWO
 * CANNOT LOSE ITS BRACKET FOR FREE.
 *
 * WHAT CHANGED. `me.payslip.deductionsHeading` was "Deductions (your share)" and is now "Deductions".
 * `me.payslip.employerContributionsHeading` was "Employer contributions (not deducted from you)" and is now
 * "Employer contributions". Twelve VALUE edits (2 keys × 6 locales), zero keys added: each target value is
 * the existing string with its parenthetical stripped, so no translation was invented. r363's
 * retire-the-old-key pattern does NOT apply — it is for when the MEANING moves to a different field, and
 * here the concept, the section and the render sites are all unchanged.
 *
 * WHY THE SECOND ONE IS NOT A PLAIN RENAME, AND THIS IS THE WHOLE POINT OF THE FILE. The ROW LABELS inside
 * the two sections are THE SAME KEYS — `me.payslip.epf`, `socso` and `eis` are rendered in both blocks — so
 * the section heading is the only thing on the page separating the employee's money from the company's. The
 * printed document already prints `payroll.individualPayslip.employerContributionsNote` under that box
 * (lib/payslip-pdf.ts `empSpec.note`), so the DOCUMENT loses the bracket for free. The three SCREENS never
 * resolved that key — it had exactly ONE call site in the whole tree, in lib/payslip-pdf-strings.ts — so
 * dropping the bracket there without adding the note would have deleted their only statement about whose
 * money it is. The note is therefore rendered on all three screens, and that is asserted below by RESOLVING
 * it through the real catalogues on a real render, not by grepping for a key.
 *
 * ONE key IS genuinely retired: `payroll.individualPayslip.employeeHeading` ("Employee information"). The
 * Individual Payslip screen stops rendering it and renders `employmentInfoHeading`, which already existed
 * and is what the DOCUMENT downloaded from that same screen has always called the block. Retired in place,
 * all six, per the house convention. `payroll.statutoryAdjustment.employeeHeading` is a DIFFERENT key on a
 * different screen and is asserted UNTOUCHED.
 *
 * WHY THE VALUES AND NOT ONLY THE KEYS. `test/i18n-coverage.test.ts` Check A is presence-in-every-locale
 * and no key was added, so it is silent here by construction. Check C gives ZERO signal on either payslip
 * screen — it skips any file binding more than one namespace and both bind several — which r363 already
 * recorded. A green i18n-coverage is not evidence about this round, so the values are pinned here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { scope, loc, ess } = vi.hoisted(() => ({
  scope: { s: null as unknown, scopeIds: [] as string[] },
  loc: { cur: 'en' as string },
  // The ESS payslip is a SERVER component behind `getSession()`. The holder is filled per test with a real
  // employee context out of the harness, so the page is rendered as the employee whose payslip it is.
  ess: { s: null as unknown },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => undefined), notFound: vi.fn(() => undefined) }));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: () => undefined })) }));
vi.mock('@/lib/session', () => ({ getSession: vi.fn(async () => ess.s) }));
// THE REAL CATALOGUE, resolved for real, exactly as r363's sibling guard does it and for the same reason:
// this round is about VALUES, and a key-echoing translator renders 'deductionsHeading' whatever the
// catalogue says. A key this resolver cannot find THROWS rather than returning the key — the in-test
// equivalent of next-intl's MISSING_MESSAGE, which otherwise hides behind a 200.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (ns: string) => {
    const nodeFs = await import('node:fs');
    const nodeUrl = await import('node:url');
    const file = nodeUrl.fileURLToPath(new URL(`../messages/${loc.cur}.json`, import.meta.url));
    const dict = JSON.parse(nodeFs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const pick = (obj: unknown, dotted: string): unknown =>
      dotted
        .split('.')
        .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
    const node = pick(dict, ns);
    return (k: string, vals?: Record<string, unknown>) => {
      const v = pick(node, k);
      if (typeof v !== 'string') throw new Error(`MISSING_MESSAGE: ${loc.cur} / ${ns}.${k}`);
      return vals ? v.replace(/\{(\w+)\}/g, (_m, n: string) => String(vals[n] ?? `{${n}}`)) : v;
    };
  }),
  getLocale: vi.fn(async () => loc.cur),
}));

import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips } from '../core/payroll';
import IndividualPayslipPage from '../app/payroll/individual-payslip/page';
import EssPayslipPage from '../app/me/payslip/[payslipId]/page';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  harnessSnapshot,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

const LOCALES = ['en', 'ms', 'zh', 'ta', 'vi', 'th'] as const;
const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
type Dict = Record<string, unknown>;
const catalogue = (l: string): Dict => JSON.parse(read(`messages/${l}.json`)) as Dict;
const at = (obj: Dict, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);
const msg = (l: string, dotted: string): string => String(at(catalogue(l), dotted));

const DEDUCTIONS = 'me.payslip.deductionsHeading';
const EMPLOYER = 'me.payslip.employerContributionsHeading';
const NOTE = 'payroll.individualPayslip.employerContributionsNote';

/** The three screens that render the two headings, and the one that also renders the block heading. */
const IP_PAGE = 'app/payroll/individual-payslip/page.tsx';
const ESS_PAGE = 'app/me/payslip/[payslipId]/page.tsx';
const HISTORY = 'app/payroll/transaction-view/history-table.tsx';

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * A. THE CATALOGUE VALUES — twelve edits, no key added, and no parenthetical left anywhere.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

describe('r367 — the two section headings lost their brackets in all six locales', () => {
  /** Any trailing bracketed qualifier, ASCII or CJK full-width. This is the thing being removed. */
  const PARENTHETICAL = /[(（][^)）]*[)）]\s*$/;

  it('THE ITEM ITSELF: both headings are non-empty, differ, and carry NO parenthetical', () => {
    for (const l of LOCALES) {
      const ded = at(catalogue(l), DEDUCTIONS);
      const emp = at(catalogue(l), EMPLOYER);
      expect(typeof ded, `${l} ${DEDUCTIONS} must exist`).toBe('string');
      expect(typeof emp, `${l} ${EMPLOYER} must exist`).toBe('string');
      expect((ded as string).trim().length, `${l} ${DEDUCTIONS} must not be blank`).toBeGreaterThan(0);
      expect((emp as string).trim().length, `${l} ${EMPLOYER} must not be blank`).toBeGreaterThan(0);
      // The two sit side by side on the page and their ROW LABELS are the same keys, so equal headings
      // would leave the reader nothing at all to tell the two populations apart.
      expect(ded, `${l}: the two section headings must not read the same`).not.toBe(emp);
      expect(ded, `${l} ${DEDUCTIONS} must have lost its "(your share)" qualifier`).not.toMatch(PARENTHETICAL);
      expect(emp, `${l} ${EMPLOYER} must have lost its "(not deducted from you)" qualifier`).not.toMatch(
        PARENTHETICAL,
      );
    }
  });

  it('each value is the OLD string with its bracket stripped — no translation was invented', () => {
    // The plan's promise, restated as the exact six-by-two. Pinned as literals because "we stripped a
    // parenthetical" is unfalsifiable on its own: a locale quietly replaced by the English word would also
    // carry no bracket.
    const EXPECTED: Record<string, Record<string, string>> = {
      [DEDUCTIONS]: {
        en: 'Deductions', ms: 'Potongan', zh: '扣除', ta: 'கழிவுகள்', vi: 'Khấu trừ', th: 'รายการหัก',
      },
      [EMPLOYER]: {
        en: 'Employer contributions',
        ms: 'Caruman majikan',
        zh: '雇主缴纳',
        ta: 'முதலாளர் பங்களிப்புகள்',
        vi: 'Đóng góp của người sử dụng lao động',
        th: 'เงินสมทบนายจ้าง',
      },
    };
    for (const key of [DEDUCTIONS, EMPLOYER]) {
      for (const l of LOCALES) expect(msg(l, key), `${l} ${key}`).toBe(EXPECTED[key][l]);
    }
  });

  it('every locale is still genuinely translated, not the English word copied across', () => {
    for (const key of [DEDUCTIONS, EMPLOYER]) {
      const en = msg('en', key);
      for (const l of LOCALES.filter((x) => x !== 'en')) {
        expect(msg(l, key), `${l} ${key} must not be the English string`).not.toBe(en);
      }
      // Resolved with a bare `t(…)` on all four surfaces, so an ICU placeholder would throw at render
      // behind a 200 and paint the key path onto a payslip.
      for (const l of LOCALES) expect(msg(l, key), `${l} ${key} must take no ICU argument`).not.toMatch(/[{}]/);
    }
  });

  it('the employer-contributions NOTE exists and is translated in all six — it is doing the bracket’s job', () => {
    const en = msg('en', NOTE);
    expect(en, 'the English sentence is the one the document already prints').toBe(
      'For reference. Paid by the company and not deducted from net pay.',
    );
    for (const l of LOCALES) {
      expect(typeof at(catalogue(l), NOTE), `${l} ${NOTE} must exist`).toBe('string');
      expect(msg(l, NOTE).trim().length, `${l} ${NOTE} must not be blank`).toBeGreaterThan(0);
      expect(msg(l, NOTE), `${l} ${NOTE} must take no ICU argument`).not.toMatch(/[{}]/);
    }
    for (const l of LOCALES.filter((x) => x !== 'en')) {
      expect(msg(l, NOTE), `${l} ${NOTE} must not be the English sentence`).not.toBe(en);
    }
  });

  it('NON-VACUITY: the old bracketed wording is gone from every catalogue, under any key', () => {
    // A value edit that only touched `en` would pass every per-key assertion above if the plan's literal
    // table were ever loosened. This looks for the phrases themselves.
    for (const l of LOCALES) {
      const raw = read(`messages/${l}.json`);
      expect(raw, `${l} must no longer carry "(your share)" anywhere`).not.toContain('(your share)');
      expect(raw, `${l} must no longer carry "(not deducted from you)" anywhere`).not.toContain(
        '(not deducted from you)',
      );
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * B. THE RETIRED KEY — and the different key with the same name that must NOT have moved.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

describe('r367 — payroll.individualPayslip.employeeHeading is retired IN PLACE', () => {
  const RETIRED = 'payroll.individualPayslip.employeeHeading';
  const KEPT = 'payroll.individualPayslip.employmentInfoHeading';
  const OTHER = 'payroll.statutoryAdjustment.employeeHeading';

  it('present in all six, identical English marker, marked r367, naming its replacement', () => {
    // The house convention (≈50 precedents per catalogue): a key that stops rendering keeps its slot and
    // its explanation, so a catalogue that still carries it cannot resolve to MISSING_MESSAGE and the
    // reason survives the round that found it. i18n-coverage Check A also requires every en.json key in
    // every locale, so a deletion would have to be six-way and simultaneous.
    const en = msg('en', RETIRED);
    expect(en, 'the retire marker names this round').toMatch(/^\[retired r367 — /);
    expect(en, 'and it says which key replaced it').toContain('employmentInfoHeading');
    expect(en, 'and it warns about the namesake it is NOT').toContain('payroll.statutoryAdjustment.employeeHeading');
    for (const l of LOCALES) {
      expect(msg(l, RETIRED), `${l} must keep the key rather than delete it`).toBe(en);
    }
  });

  it('the replacement was already translated in all six — this round invented nothing', () => {
    expect(msg('en', KEPT), 'the wording the DOCUMENT has always used').toBe('Employment info');
    for (const l of LOCALES) {
      expect(msg(l, KEPT).trim().length, `${l} ${KEPT} must not be blank`).toBeGreaterThan(0);
      expect(msg(l, KEPT), `${l} ${KEPT} must not have been retired`).not.toMatch(/^\[retired/);
      expect(msg(l, KEPT), `${l} ${KEPT} must take no ICU argument`).not.toMatch(/[{}]/);
    }
  });

  it('⚠️ payroll.statutoryAdjustment.employeeHeading was NOT touched — different key, different screen', () => {
    expect(msg('en', OTHER), 'the statutory-adjustment screen keeps its own heading').toBe('Employee');
    for (const l of LOCALES) {
      expect(msg(l, OTHER), `${l} ${OTHER} must not have been retired`).not.toMatch(/^\[retired/);
      expect(msg(l, OTHER).trim().length, `${l} ${OTHER} must not be blank`).toBeGreaterThan(0);
    }
    // …and it still has its render sites, which is the behavioural half of "do not touch it".
    expect(read('app/payroll/statutory-adjustment/page.tsx')).toContain("employeeHeading: t('employeeHeading')");
  });

  it('the Individual Payslip screen no longer resolves the retired key, and resolves the new one', () => {
    // Comments are stripped first: the retire is EXPLAINED in prose at the render site, and prose is not a
    // resolution. A retired key that something still resolves paints its own marker onto the screen.
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const src = strip(read(IP_PAGE));
    expect(src, 'the retired key has no render site left on this screen').not.toMatch(/t\(\s*'employeeHeading'\s*\)/);
    expect(src, 'and the block is headed by the wording the document uses').toMatch(
      /t\(\s*'employmentInfoHeading'\s*\)/,
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * C. THE THREE SCREEN CALL SITES — the note is bound and resolved on each, not merely present in JSON.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

describe('r367 — all three screens now render the employer-contributions note', () => {
  it('each screen binds payroll.individualPayslip and resolves the note through it', () => {
    // The key lived under a namespace NONE of the three bound. Binding is half the change and it is the
    // half that a value assertion cannot see: an unbound namespace raises MISSING_MESSAGE at render, which
    // passes tsc, the suite and `next build`.
    const BINDINGS: [string, RegExp, RegExp][] = [
      [IP_PAGE, /getTranslations\('payroll\.individualPayslip'\)/, /\{t\('employerContributionsNote'\)\}/],
      [ESS_PAGE, /getTranslations\('payroll\.individualPayslip'\)/, /\{tIp\('employerContributionsNote'\)\}/],
      [HISTORY, /useTranslations\('payroll\.individualPayslip'\)/, /\{tIp\('employerContributionsNote'\)\}/],
    ];
    for (const [file, binding, call] of BINDINGS) {
      const src = read(file);
      expect(src, `${file} must bind payroll.individualPayslip`).toMatch(binding);
      expect(src, `${file} must resolve employerContributionsNote`).toMatch(call);
    }
  });

  it('and the key’s only OTHER call site — the document — is untouched', () => {
    expect(read('lib/payslip-pdf-strings.ts'), 'the document still resolves it').toMatch(
      /employerContributionsNote: tIp\('employerContributionsNote'\)/,
    );
    expect(read('lib/payslip-pdf.ts'), 'and still prints it under the employer box').toContain(
      'note: t.employerContributionsNote,',
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * D. RENDERED — what a reader actually sees on the Individual Payslip screen, in several locales.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/** Every string anywhere in the tree — headings, labels, note text. */
function textOf(node: unknown, acc: string[] = []): string[] {
  if (node == null) return acc;
  if (typeof node === 'string') {
    acc.push(node);
    return acc;
  }
  if (typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, acc);
    return acc;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (node as any).props ?? {};
  for (const k of Object.keys(p)) textOf(p[k], acc);
  return acc;
}

/** Every element in the tree, depth-first. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nodes(node: unknown, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) nodes(n, acc);
    return acc;
  }
  acc.push(node);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (node as any).props ?? {};
  for (const k of Object.keys(p)) if (p[k] && typeof p[k] === 'object') nodes(p[k], acc);
  return acc;
}

let base: Base;
let admin: ReturnType<typeof adminCtx>;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  admin = adminCtx(base);
  scope.s = admin;
  scope.scopeIds = [base.companyId];
  loc.cur = 'en';
});

/** One fully-configured employee with one processed run — the shape the screen needs to draw a payslip. */
async function oneProcessedPayslip() {
  const e = await hireEmployee(admin, {
    person: { fullName: 'Aisyah Rahman', primaryEmail: 'aisyah.headings@acme.test' },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(admin, {
    employmentId: e.employmentId,
    basicSalary: 6500,
    monthlyAllowance: 500,
    effectiveFrom: '2026-01-01',
  });
  await setStatutoryProfileMY(admin, {
    personId: e.personId,
    icNumber: '900101011234',
    taxCategory: 2,
    numChildren: 2,
    bankName: 'Maybank',
    bankAccountNo: '512345678901',
  });
  const { batchId } = await createBatch(admin, { companyId: base.companyId, payPeriod: '2026-03' });
  await generatePayslips(admin, { batchId });
  return e.employmentId;
}

describe('r367 — on the rendered Individual Payslip the brackets are gone and the note is there', () => {
  // English, the Malay a Malaysian tenant reads, and a non-Latin script where a stale copy would be
  // least visible by eye.
  for (const locale of ['en', 'ms', 'zh'] as const) {
    it(`[${locale}] the two headings read plainly and the note carries what the bracket carried`, async () => {
      loc.cur = locale;
      const employmentId = await oneProcessedPayslip();
      const tree = await IndividualPayslipPage({ searchParams: Promise.resolve({ employmentId }) });
      const texts = textOf(tree);

      // 1. THE HEADINGS, as VALUES. Asserted against the catalogue rather than against a key name: a
      //    screen that still resolved a bracketed value would pass a key-shaped assertion.
      expect(texts, `${locale}: the Deductions block is headed plainly`).toContain(msg(locale, DEDUCTIONS));
      expect(texts, `${locale}: the Employer contributions block is headed plainly`).toContain(
        msg(locale, EMPLOYER),
      );

      // 2. NO BRACKETED HEADING SURVIVES ANYWHERE ON THE SCREEN.
      for (const s of texts) {
        expect(s, `${locale}: no "(your share)" may reach the page`).not.toContain('(your share)');
        expect(s, `${locale}: no "(not deducted from you)" may reach the page`).not.toContain(
          '(not deducted from you)',
        );
      }

      // 3. THE NOTE. This is the load-bearing half: the row labels inside the two blocks are the same
      //    keys, so without this sentence the screen would make NO statement about whose money is whose.
      expect(texts, `${locale}: the employer-contributions note renders`).toContain(msg(locale, NOTE));

      // 4. THE BLOCK HEADING the screen and the document now share.
      expect(texts, `${locale}: the employee block is headed "Employment info"`).toContain(
        msg(locale, 'payroll.individualPayslip.employmentInfoHeading'),
      );

      // 5. NO RETIRE MARKER REACHES A READER. A retired key that is still resolved paints its own
      //    explanation onto the screen — a louder failure than the label it replaced.
      expect(
        texts.filter((s) => s.includes('[retired r')),
        `${locale}: no retire marker may render`,
      ).toEqual([]);
    });
  }

  it('the note sits INSIDE the Employer contributions block, not loose on the page', async () => {
    // Placement is the whole value of the sentence: under Deductions it would say the opposite of what it
    // means. The Block that carries the employer heading must be the one carrying the note.
    const employmentId = await oneProcessedPayslip();
    const tree = await IndividualPayslipPage({ searchParams: Promise.resolve({ employmentId }) });
    const blocks = nodes(tree).filter((el) => typeof el.props?.title === 'string');
    const employerBlock = blocks.filter((b) => b.props.title === msg('en', EMPLOYER));
    expect(employerBlock.map((b) => b.props.title), 'exactly one Employer contributions block').toHaveLength(1);
    expect(
      textOf(employerBlock[0].props.children),
      'the note is inside that block',
    ).toContain(msg('en', NOTE));
    // …and NOT inside the Deductions block, where it would be a false statement.
    const deductionsBlock = blocks.filter((b) => b.props.title === msg('en', DEDUCTIONS));
    expect(deductionsBlock, 'exactly one Deductions block').toHaveLength(1);
    expect(
      textOf(deductionsBlock[0].props.children),
      'the note is NOT in the Deductions block',
    ).not.toContain(msg('en', NOTE));
  });

  it('the deduction ROWS and the total were not touched — this round is display text only', async () => {
    // A separate item (970e4143) covers a CP38 double-count in that same box. This round must not have
    // moved a figure or a row while renaming the heading above them.
    const employmentId = await oneProcessedPayslip();
    const tree = await IndividualPayslipPage({ searchParams: Promise.resolve({ employmentId }) });
    const blocks = nodes(tree).filter((el) => el.props?.title === msg('en', DEDUCTIONS));
    const rows = nodes(blocks[0].props.children)
      .filter((el) => typeof el.props?.label === 'string' && 'value' in (el.props ?? {}))
      .map((el) => el.props.label);
    // The statutory four are always drawn, zeros included (a96d320c rev 2), and they are the same keys
    // the Employer contributions block draws — which is exactly why the heading has to carry the claim.
    for (const k of ['epf', 'socso', 'eis', 'pcb'] as const) {
      expect(rows, `the ${k} deduction row is still drawn`).toContain(msg('en', `me.payslip.${k}`));
    }
    expect(textOf(blocks[0].props.children), 'and TOTAL DEDUCTIONS still closes the block').toContain(
      msg('en', 'me.payslip.totalDeductions'),
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * E. THE EMPLOYEE'S OWN PAYSLIP — the surface where the bracket mattered most, rendered.
 *
 * This is the copy the employee files. Its Deductions and Employer contributions sections draw THE SAME
 * ROW KEYS (`me.payslip.epf`, `socso`, `eis`), so before this round the heading's bracket was the only
 * thing on the page telling the reader which of the two figures came out of their pay. The note now says
 * it, in more words than a bracket had room for, and this case proves it RESOLVES rather than that the key
 * exists — the page had never bound `payroll.individualPayslip` at all, and an unbound namespace raises
 * MISSING_MESSAGE at render, behind a 200, past tsc and past `next build`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

describe('r367 — the employee’s own payslip renders the note under a plain employer heading', () => {
  /** A RELEASED payslip, read as the employee it belongs to — the ESS gate is on `released_at`. */
  async function releasedPayslipAsEmployee() {
    const e = await hireEmployee(admin, {
      person: { fullName: 'Aisyah Rahman', primaryEmail: 'aisyah.ess.headings@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(admin, {
      employmentId: e.employmentId,
      basicSalary: 6500,
      monthlyAllowance: 500,
      effectiveFrom: '2026-01-01',
    });
    await setStatutoryProfileMY(admin, { personId: e.personId, icNumber: '900101011234' });
    const { batchId } = await createBatch(admin, { companyId: base.companyId, payPeriod: '2026-03' });
    await generatePayslips(admin, { batchId });
    // CLOSE, which is what releases the slip to the employee. Without it `payslipDetail` returns null and
    // the page would render nothing — a green assertion over an empty tree.
    await closeBatch(admin, { batchId });
    const [slip] = await owner.db
      .select({ id: schema.payslip.id })
      .from(schema.payslip)
      .where(eq(schema.payslip.batchId, batchId));
    expect(slip, 'the run produced a payslip').toBeTruthy();
    const userId = await createAppUser(base.tenantId, e.personId, 'employee');
    const session: SessionContext = {
      tenantId: base.tenantId,
      userId,
      roles: ['employee'],
      personId: e.personId,
      entitlements: harnessSnapshot(base.tenantId),
    };
    return { payslipId: slip.id as string, session };
  }

  for (const locale of ['en', 'ms'] as const) {
    it(`[${locale}] the plain headings and the note both reach the employee’s copy`, async () => {
      loc.cur = locale;
      const { payslipId, session } = await releasedPayslipAsEmployee();
      ess.s = session;
      const tree = await EssPayslipPage({ params: Promise.resolve({ payslipId }) });
      const texts = textOf(tree);

      // NON-VACUITY FIRST: the page really did render a payslip, not a notFound() shell. Without this the
      // three assertions below could all pass over nothing.
      expect(texts, `${locale}: the page rendered the employee’s name`).toContain('Aisyah Rahman');
      expect(texts, `${locale}: …and its NET PAY band`).toContain(msg(locale, 'me.payslip.netPay'));

      expect(texts, `${locale}: the Deductions section is headed plainly`).toContain(msg(locale, DEDUCTIONS));
      expect(texts, `${locale}: the Employer contributions section is headed plainly`).toContain(
        msg(locale, EMPLOYER),
      );
      expect(texts, `${locale}: THE NOTE — the only statement left about whose money is whose`).toContain(
        msg(locale, NOTE),
      );
      for (const s of texts) {
        expect(s, `${locale}: no bracketed qualifier survives on the employee’s copy`).not.toContain(
          '(your share)',
        );
        expect(s, `${locale}: …nor the employer one`).not.toContain('(not deducted from you)');
      }
      expect(
        texts.filter((s) => s.includes('[retired r')),
        `${locale}: no retire marker may render`,
      ).toEqual([]);
    });
  }

  it('the note sits in the EMPLOYER section, and the same row labels really do appear in both', () => {
    // THE PREMISE OF THE WHOLE ROUND, asserted rather than asserted-about: the two sections share their
    // row keys. If this ever stopped being true the note would stop being load-bearing, and a future round
    // could drop it without noticing. Read off the source of the one file that draws both sections.
    const src = read(ESS_PAGE);
    const employerSection = src.slice(src.indexOf("t('employerContributionsHeading')"));
    const deductionsSection = src.slice(
      src.indexOf("t('deductionsHeading')"),
      src.indexOf("t('employerContributionsHeading')"),
    );
    for (const k of ['epf', 'socso', 'eis'] as const) {
      expect(deductionsSection, `${k} is a Deductions row`).toContain(`t('${k}')`);
      expect(employerSection, `${k} is ALSO an Employer contributions row — same key, same words`).toContain(
        `t('${k}')`,
      );
    }
    expect(
      employerSection.slice(0, employerSection.indexOf('</section>')),
      'and the note is inside the employer section, not the deductions one',
    ).toContain("tIp('employerContributionsNote')");
    expect(deductionsSection, 'the note is NOT under Deductions, where it would be false').not.toContain(
      "tIp('employerContributionsNote')",
    );
  });
});
