/**
 * One exception's line of evidence, in words: which sentence (`detail.*` in `aiCentre.exceptions.grouped`) and which of
 * the finding's stored figures fill it. PURE.
 *
 * NO FIGURE IS COMPUTED HERE. Every amount is a value the check stored on the finding when it ran (its `facts`); this
 * only picks them out by name and says which are money, so the page can format them with the shared money formatter.
 * A finding missing a figure its sentence needs gets the generic sentence instead of a blank or a raw field name.
 */
import { KNOWN_COMPONENTS, OTHER_COMPONENT, entryOf, variantOf } from './catalogue';

export type FindingDetail = Readonly<{
  /** Message key under `aiCentre.exceptions.grouped`. */
  key: string;
  /** Amounts, to be formatted as money. */
  money: Readonly<Record<string, number>>;
  /** Plain numbers (days, a count, a percentage). */
  numbers: Readonly<Record<string, number>>;
  /** A pay item's label key under `component.`, when the sentence names one. */
  component?: string;
  /** `up` or `down`, for a pay change. */
  direction?: 'up' | 'down';
  /** A pay change's payroll explanations, as label keys under `cause.` (never the stored cause ids). */
  causes?: readonly string[];
  /** How much of a pay change nothing explains, as a rounded whole percentage. */
  unexplainedPct?: number;
}>;

/** The payroll records that can explain a pay change (core/payroll-anomaly-detectors.ts `explainedCauses`). */
export const NET_SWING_CAUSES = ['additional_run', 'salary_change', 'days_paid', 'overtime_hours', 'unpaid_leave', 'absence', 'statutory_rules'] as const;

/** `explainedCauses` is stored comma-separated; an array is read too. Unknown ids become "another payroll record". */
function causeKeys(value: unknown): string[] {
  const ids = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string' ? value.split(',') : [];
  const keys = ids.map(id => id.trim()).filter(Boolean)
    .map(id => `cause.${(NET_SWING_CAUSES as readonly string[]).includes(id) ? id : 'other'}`);
  return [...new Set(keys)];
}

const GENERIC: FindingDetail = Object.freeze({ key: 'detail.generic', money: {}, numbers: {} });

const num = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

/** All of the named figures, or null when any is absent. */
function figures(facts: Readonly<Record<string, unknown>>, names: readonly string[]): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const name of names) {
    const n = num(facts[name]);
    if (n === null) return null;
    out[name] = n;
  }
  return out;
}

const componentKey = (value: unknown) =>
  `component.${typeof value === 'string' && (KNOWN_COMPONENTS as readonly string[]).includes(value) ? value : OTHER_COMPONENT}`;

export function findingDetail(checkId: string, rawFacts: Readonly<Record<string, unknown>> | null | undefined): FindingDetail {
  const facts = rawFacts ?? {};
  const entry = entryOf(checkId);
  if (!entry) return GENERIC;
  const money = (names: string[], key = `detail.${entry.key}`) => {
    const m = figures(facts, names);
    return m ? { key, money: m, numbers: {} } : GENERIC;
  };
  switch (checkId) {
    case 'negative-net':
      return money(['grossPay', 'totalDeductions', 'netPay']);
    case 'zero-net-with-pay':
      return money(['grossPay', 'totalDeductions']);
    case 'statutory-over-cap': {
      const m = figures(facts, ['actual', 'cap', 'excess']);
      return m ? { key: 'detail.statutoryOverCap', money: m, numbers: {}, component: componentKey(facts.component) } : GENERIC;
    }
    case 'missing-bank-profile': {
      // The reason, or for older findings the payment method the check recorded (catalogue.ts `variantOf`).
      const variant = variantOf(checkId, facts);
      const reason = variant === 'payment-method-not-set' ? 'detail.missingBankProfile.paymentMethodNotSet'
        : variant === 'bank-details-missing' ? 'detail.missingBankProfile.bankDetailsMissing' : 'detail.missingBankProfile.generic';
      return money(['netPay'], reason);
    }
    case 'missing-tax-profile': {
      const pcb = num(facts.pcb);
      return pcb !== null && pcb > 0 ? { key: 'detail.missingTaxProfile.withTax', money: { pcb }, numbers: {} }
        : { key: 'detail.missingTaxProfile.noTax', money: {}, numbers: {} };
    }
    case 'pay-without-attendance':
      return money(['netPay']);
    case 'proration-mismatch': {
      const n = figures(facts, ['daysWorked', 'periodDays']);
      return n ? { key: 'detail.prorationMismatch', money: {}, numbers: n } : GENERIC;
    }
    case 'duplicate-employment-pay': {
      const m = figures(facts, ['netPay']);
      const others = num(facts.otherEmployments);
      return m && others !== null ? { key: 'detail.duplicateEmploymentPay', money: m, numbers: { others } } : GENERIC;
    }
    case 'net-swing': {
      const m = figures(facts, ['priorNetPay', 'netPay']);
      const pct = num(facts.movementPct);
      if (!m || pct === null) return GENERIC;
      // Optional on verdicts from before the Salary-loop explanation (owner decision, 11 November 2026): absent, the
      // sentence simply says less.
      const causes = causeKeys(facts.explainedCauses);
      const share = num(facts.unexplainedShare);
      return { key: 'detail.netSwing', money: m, numbers: { pct: Math.abs(pct) }, direction: pct < 0 ? 'down' : 'up',
        ...(causes.length ? { causes } : {}),
        ...(causes.length && share !== null && share >= 0 && share <= 1 ? { unexplainedPct: Math.round(share * 100) } : {}) };
    }
    case 'component-appeared': {
      const m = figures(facts, ['amount']);
      return m ? { key: 'detail.componentAppeared', money: m, numbers: {}, component: componentKey(facts.component) } : GENERIC;
    }
    case 'component-vanished': {
      const m = figures(facts, ['priorAmount']);
      return m ? { key: 'detail.componentVanished', money: m, numbers: {}, component: componentKey(facts.component) } : GENERIC;
    }
    case 'hypothesis':
      return { key: 'detail.hypothesis', money: {}, numbers: {} };
    default:
      return GENERIC;
  }
}

/** Every `detail.*` key `findingDetail` can return, for the completeness test. */
export const DETAIL_KEYS: readonly string[] = Object.freeze([
  'detail.generic', 'detail.negativeNet', 'detail.zeroNetWithPay', 'detail.statutoryOverCap',
  'detail.missingBankProfile.generic', 'detail.missingBankProfile.paymentMethodNotSet', 'detail.missingBankProfile.bankDetailsMissing',
  'detail.missingTaxProfile.withTax', 'detail.missingTaxProfile.noTax', 'detail.payWithoutAttendance', 'detail.prorationMismatch',
  'detail.duplicateEmploymentPay', 'detail.netSwing', 'detail.netSwingExplained', 'detail.componentAppeared', 'detail.componentVanished', 'detail.hypothesis',
]);
