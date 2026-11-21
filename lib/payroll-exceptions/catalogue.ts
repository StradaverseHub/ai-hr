/**
 * The plain-language catalogue of every payroll check whose findings the Exceptions page shows (AI-native batch,
 * 11 November 2026; owner: "every issue must read as plain human language, with no field names, ids or jargon").
 *
 * PURE. No I/O, no clock, no model. It maps a stored check id (the anomaly layer's detector ids, plus the hypothesis
 * id the model-proposed findings carry) to the message keys its title, its "why it matters" and its "what to do" live
 * under in `aiCentre.exceptions.grouped.check.*`, in every shipped locale. It never changes a finding, a severity or a
 * figure: it only decides which sentence is shown beside one.
 *
 * ONE OWNER OF THE IDS. The detector registry (core/payroll-anomaly-detectors.ts) owns which checks exist; this file
 * must name each of them, and test/payroll-exceptions-catalogue.test.ts fails the build when one is missing here or in
 * any locale. An id that reaches the page without an entry (a check added later, a stray row) still renders, with the
 * catalogue's generic copy, never its raw id.
 *
 * VARIANTS. Two checks carry a fact that changes what a person must do:
 *  - `missing-bank-profile` may carry `reason` (`payment-method-not-set` or `bank-details-missing`). Older findings
 *    without it are read from the payment method the check recorded (`paymentMethod`: `unset` or null means none was
 *    set, `bank_transfer` means the bank details are missing); with neither, the generic copy;
 *  - `component-appeared` / `component-vanished` carry `component`, the pay item that appeared or disappeared. A known
 *    pay item has its own plain label; anything else is "another pay item".
 */

/** The id every model-proposed hypothesis finding carries (core/payroll-anomaly-detectors.ts HYPOTHESIS_DETECTOR_ID). */
export const HYPOTHESIS_CHECK_ID = 'hypothesis';

/** Where a check naturally sits. Classification (classify.ts) combines this with the finding's severity. */
export type NaturalBucket = 'check' | 'missing' | 'setup';

export type CatalogueEntry = Readonly<{
  /** The message key segment under `check.` (camelCase of the id; never rendered). */
  key: string;
  natural: NaturalBucket;
  /** Which fact splits this check into sub-groups, and the values that get their own copy. */
  variant?: Readonly<{ fact: 'reason' | 'component'; values: readonly string[]; otherwise: 'generic' | 'other';
    /** For findings written before `fact` existed: the variant read from another stored fact. */
    legacy?: Readonly<{ fact: string; map: Readonly<Record<string, string>>; nullAs?: string }> }>;
  /** The record tab a person fixes it on (missing details only), per variant where it differs. */
  fixTab?: Readonly<Record<string, RecordTab>>;
}>;

export type RecordTab = 'payroll' | 'bankStatutory';

export const BANK_REASONS = ['payment-method-not-set', 'bank-details-missing'] as const;

/** Pay items a person recognises by name. The component facts are the payslip's own item names. */
export const KNOWN_COMPONENTS = [
  'allowance', 'overtimePay', 'bonus', 'epfEmployee', 'epfEmployer', 'socsoEmployee', 'socsoEmployer',
  'eisEmployee', 'eisEmployer', 'pcb', 'hrdf', 'zakat', 'skbbk',
] as const;
export const OTHER_COMPONENT = 'other';

const componentVariant = { fact: 'component', values: KNOWN_COMPONENTS, otherwise: 'other' } as const;

export const CATALOGUE: Readonly<Record<string, CatalogueEntry>> = Object.freeze({
  'negative-net': { key: 'negativeNet', natural: 'check' },
  'statutory-over-cap': { key: 'statutoryOverCap', natural: 'check' },
  'missing-bank-profile': {
    key: 'missingBankProfile', natural: 'missing',
    variant: { fact: 'reason', values: BANK_REASONS, otherwise: 'generic',
      legacy: { fact: 'paymentMethod', map: { unset: 'payment-method-not-set', bank_transfer: 'bank-details-missing' }, nullAs: 'payment-method-not-set' } },
    fixTab: { 'payment-method-not-set': 'payroll', 'bank-details-missing': 'bankStatutory', '': 'bankStatutory' },
  },
  'duplicate-employment-pay': { key: 'duplicateEmploymentPay', natural: 'check' },
  'zero-net-with-pay': { key: 'zeroNetWithPay', natural: 'check' },
  'missing-tax-profile': { key: 'missingTaxProfile', natural: 'missing', fixTab: { '': 'bankStatutory' } },
  'pay-without-attendance': { key: 'payWithoutAttendance', natural: 'setup' },
  'proration-mismatch': { key: 'prorationMismatch', natural: 'check' },
  'net-swing': { key: 'netSwing', natural: 'check' },
  'component-appeared': { key: 'componentAppeared', natural: 'setup', variant: componentVariant },
  'component-vanished': { key: 'componentVanished', natural: 'setup', variant: componentVariant },
  [HYPOTHESIS_CHECK_ID]: { key: 'hypothesis', natural: 'check' },
});

/** The key segment for a check nobody catalogued: generic copy, never the id. */
export const UNKNOWN_KEY = 'unknown';

export const entryOf = (checkId: string): CatalogueEntry | null =>
  Object.prototype.hasOwnProperty.call(CATALOGUE, checkId) ? CATALOGUE[checkId] : null;

/** `payment-method-not-set` → `paymentMethodNotSet`. Only ever used to build a message key. */
export const camelKey = (value: string) => value.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * The sub-group a finding belongs to, from its stored facts. The SQL that groups findings (app/control-tower/exceptions/
 * data.ts) is generated from the same CATALOGUE, and its database test pins that the two agree.
 */
export function variantOf(checkId: string, facts: Readonly<Record<string, unknown>> | null | undefined): string | null {
  const variant = entryOf(checkId)?.variant;
  if (!variant) return null;
  const value = facts?.[variant.fact];
  if (typeof value === 'string' && variant.values.includes(value)) return value;
  const legacy = variant.legacy;
  if (legacy && facts && Object.prototype.hasOwnProperty.call(facts, legacy.fact)) {
    const old = facts[legacy.fact];
    if (old === null && legacy.nullAs) return legacy.nullAs;
    if (typeof old === 'string' && Object.prototype.hasOwnProperty.call(legacy.map, old)) return legacy.map[old];
  }
  return variant.otherwise === 'other' ? OTHER_COMPONENT : null;
}

export type CheckCopy = Readonly<{
  /** Message keys under `aiCentre.exceptions.grouped`. */
  title: string;
  why: string;
  todo: string;
  /** Set when the title names a pay item: the key of its label under `component.`. */
  component?: string;
}>;

/** Which sentences describe one group of findings. */
export function checkCopy(checkId: string, variant: string | null): CheckCopy {
  const entry = entryOf(checkId);
  if (!entry) return { title: `check.${UNKNOWN_KEY}.title`, why: `check.${UNKNOWN_KEY}.why`, todo: `check.${UNKNOWN_KEY}.todo` };
  const base = `check.${entry.key}`;
  if (entry.variant?.fact === 'reason' && variant && entry.variant.values.includes(variant)) {
    const sub = `${base}.${camelKey(variant)}`;
    return { title: `${sub}.title`, why: `${sub}.why`, todo: `${sub}.todo` };
  }
  if (entry.variant?.fact === 'component' && variant) {
    return { title: `${base}.titleNamed`, why: `${base}.why`, todo: `${base}.todo`, component: `component.${variant}` };
  }
  return { title: `${base}.title`, why: `${base}.why`, todo: `${base}.todo` };
}

/** Every message key the catalogue can ask for, for the completeness test. */
export function catalogueMessageKeys(): string[] {
  const keys = new Set<string>();
  const add = (copy: CheckCopy) => { keys.add(copy.title); keys.add(copy.why); keys.add(copy.todo); if (copy.component) keys.add(copy.component); };
  for (const [id, entry] of Object.entries(CATALOGUE)) {
    add(checkCopy(id, null));
    if (entry.variant) {
      for (const value of entry.variant.values) add(checkCopy(id, value));
      if (entry.variant.otherwise === 'other') add(checkCopy(id, OTHER_COMPONENT));
    }
  }
  add(checkCopy('not-a-catalogued-check', null));
  return [...keys].sort();
}

/** The record tab where a missing detail is filled in, or null when the check is not a missing detail. */
export function fixTabOf(checkId: string, variant: string | null): RecordTab | null {
  const tabs = entryOf(checkId)?.fixTab;
  if (!tabs) return null;
  return tabs[variant ?? ''] ?? tabs[''] ?? null;
}
