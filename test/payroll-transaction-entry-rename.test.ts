/**
 * 8041aa84 — the Payroll "Transactions" sub-menu is renamed to "Transaction Entry".
 *
 * WORDING ONLY. The route `/payroll/transactions`, the nav registry's `labelKey`
 * ('payrollTransactions') and every calculation, guard and workflow underneath are untouched — the
 * reporter's bookmarks have to keep working, and the label is the only thing that changed.
 *
 * WHY A GUARD FOR A RENAME. Three separate ways this can rot, none of which any existing test sees:
 *
 *   A. THE LABEL DRIFTS APART. Four keys carry the screen's NAME (the sidebar row, the page header,
 *      the Back link from Import payroll history, the guide reference) and a fifth names it in prose
 *      on the Payroll run screen. They are edited in four different files by four different rounds;
 *      nothing binds them together, so one can be renamed and the others left behind. The operator
 *      then clicks one word and lands on a page titled another.
 *
 *   B. THE TRANSLATIONS SILENTLY REVERT TO ENGLISH. scripts/i18n-check.mjs enforces key parity and
 *      ICU placeholders — it CANNOT tell whether a value is the right words. "Transaction Entry" left
 *      verbatim in ms/ta/th/vi/zh would ship green (HANDOFF trap 19b), so this file asserts each
 *      non-English locale carries its own translation, distinct from the English one — and, because a
 *      translation can be genuinely non-English and STILL collide with the command next to it, that no
 *      locale's name is the opening of the Excel-import title the same screen shows.
 *
 *   C. THE READINESS-CHECK KEY FRAGMENTS GET "RENAMED" TOO. `transactions: 'Transactions'` in
 *      app/payroll/[batchId]/page.tsx (CHECK_CAP) and app/payroll/setup/page.tsx is NOT a label: line
 *      661 composes tg(`check${CHECK_CAP[c.key]}Title`). Rename that value and the lookup misses,
 *      rendering MISSING_MESSAGE on the run screen — a failure that passes tsc, the suite AND
 *      `next build` (AGENTS 6) and only ever appears on screen. Both halves of that contract are
 *      asserted here: the map entry's source shape, and that the composed key resolves in all six
 *      locales.
 *
 * The keys that use "transactions" as a COMMON NOUN for the data (outstanding transactions, the
 * Transaction Detail export, the separate Transaction view screen) are pinned unchanged, so a future
 * sweep of the word cannot quietly make those sentences wrong.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { payrollPack } from '../packs/payroll';

const ROOT = path.resolve(__dirname, '..');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
type Locale = (typeof LOCALES)[number];

const dicts = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${l}.json`), 'utf8'))]),
) as Record<Locale, Record<string, unknown>>;

const resolve = (dict: Record<string, unknown>, dotted: string): unknown =>
  dotted
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), dict);

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * The screen's name, per locale. Real translations of "Transaction Entry", not the English words
 * carried through — that is the whole point of assertion B.
 */
const LABEL: Record<Locale, string> = {
  en: 'Transaction Entry',
  ms: 'Kemasukan Transaksi',
  ta: 'பரிவர்த்தனை உள்ளீடு',
  th: 'บันทึกธุรกรรม',
  vi: 'Nhập liệu giao dịch',
  zh: '交易录入',
};

/** The four keys whose ENTIRE value is the screen's name. */
const NAME_KEYS = [
  'nav.payrollTransactions', // the sidebar row (packs/payroll/index.ts labelKey)
  'payroll.transactions.title', // the page header — and the Back label of all six sub-screens
  'payroll.historyImport.backLabel', // Back from Import payroll history
  'payroll.guide.linkTransactions', // the in-product guide reference
] as const;

/** Keys that MENTION the screen inside a sentence. Each must name it, and name it correctly. */
const PROSE_KEYS = [
  'payroll.process.transactionsPrerequisiteNote', // "…on the Transaction Entry screen before running"
  'people.detail.zakatSummaryDescription', // "Manage it in Payroll → Transaction Entry → Zakat."
  'people.detail.zakatMoved', // "Zakat has moved to Payroll → Transaction Entry → Zakat."
] as const;

describe('8041aa84 — Payroll Transactions renamed to Transaction Entry', () => {
  it('A. every key that names the screen carries the new label, in all six locales', () => {
    for (const l of LOCALES) {
      for (const k of NAME_KEYS) {
        expect(resolve(dicts[l], k), `${l}.json → ${k}`).toBe(LABEL[l]);
      }
    }
  });

  it('A. the prose that points at the screen names it by its new label, in all six locales', () => {
    for (const l of LOCALES) {
      for (const k of PROSE_KEYS) {
        const v = resolve(dicts[l], k);
        expect(typeof v, `${l}.json → ${k} missing`).toBe('string');
        expect(v as string, `${l}.json → ${k} must name the screen`).toContain(LABEL[l]);
      }
    }
    // The English sentence in full, so a reworded note still has to say where to go.
    expect(resolve(dicts.en, 'payroll.process.transactionsPrerequisiteNote') as string).toContain(
      'on the Transaction Entry screen before running',
    );
  });

  it('B. ms/ta/th/vi/zh are translated, not the English label left in place', () => {
    for (const l of LOCALES) {
      if (l === 'en') continue;
      const v = resolve(dicts[l], 'nav.payrollTransactions') as string;
      expect(v, `${l}.json → nav.payrollTransactions is still English`).not.toBe(LABEL.en);
      expect(v, `${l}.json → nav.payrollTransactions contains the English label`).not.toContain('Transaction Entry');
    }
  });

  it('B. no locale reuses the import action\'s own wording for the screen label', () => {
    // The label and payroll.txnImport.title.* meet on ONE screen: the label is the PageHeader Back
    // link of /payroll/transactions/{fixed,individual}, and the import title is the dialog those pages
    // open. When the import title merely extends the label, the two controls read as the same command
    // and the Back link looks like it will pull in a spreadsheet. vi shipped exactly that collision in
    // this round's first cut, so the screen's name has to stand apart from the import wording.
    for (const l of LOCALES) {
      for (const variant of ['fixed', 'individual'] as const) {
        const importTitle = resolve(dicts[l], `payroll.txnImport.title.${variant}`);
        expect(typeof importTitle, `${l}.json → payroll.txnImport.title.${variant} missing`).toBe('string');
        expect(
          (importTitle as string).startsWith(LABEL[l]),
          `${l}.json → payroll.txnImport.title.${variant} starts with the screen label "${LABEL[l]}" — on that screen the Back link and the import action read alike`,
        ).toBe(false);
      }
    }
  });

  it('C. the readiness-check KEY FRAGMENT is untouched, and the key it composes still resolves', () => {
    // Not labels: `check${CHECK_CAP[c.key]}Title` is built from these values.
    for (const rel of ['app/payroll/[batchId]/page.tsx', 'app/payroll/setup/page.tsx']) {
      expect(read(rel), `${rel}: the CHECK_CAP entry was renamed — the composed message key would miss`).toContain(
        "transactions: 'Transactions',",
      );
    }
    for (const l of LOCALES) {
      expect(resolve(dicts[l], 'payroll.guide.checkTransactionsTitle'), `${l}.json → checkTransactionsTitle`).toEqual(
        expect.any(String),
      );
    }
  });

  it('the route and the nav registry identifier are unchanged — bookmarks keep working', () => {
    const node = payrollPack.navNodes!.find((n) => n.group === 'admin')!;
    const row = node.children!.find((c) => c.href === '/payroll/transactions');
    expect(row, 'the /payroll/transactions row left the payroll fly-out').toBeTruthy();
    expect(row!.labelKey, 'labelKey is the registry identifier, asserted in test/payroll-flyout-nav.test.ts').toBe(
      'payrollTransactions',
    );
    expect(fs.existsSync(path.join(ROOT, 'app/payroll/transactions/page.tsx'))).toBe(true);
  });

  it('"transactions" as a COMMON NOUN, and the other Transaction screens, are left alone', () => {
    // These describe the DATA or a different artefact; renaming them makes the sentences wrong.
    expect(resolve(dicts.en, 'payroll.batch.outstandingTxnLink')).toBe('View outstanding transactions');
    expect(resolve(dicts.en, 'payroll.batch.scopeUnattachedTitle')).toBe(
      "{n} employee(s) outside this run's scope have transactions waiting",
    );
    expect(resolve(dicts.en, 'payroll.process.unattachedScopeTitle')).toBe(
      '{n} employee(s) have transactions this run will not collect',
    );
    expect(resolve(dicts.en, 'payroll.batch.transactionDetail')).toBe('Transaction Detail'); // a different export
    expect(resolve(dicts.en, 'payroll.guide.phase5Title')).toBe('Transaction view'); // a different screen
  });
});
