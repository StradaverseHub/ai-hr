/**
 * ONE reader for the LHDN TP1 (1/2026) declaration form (item 7ad37961, ADR-0081).
 *
 * WHY IT IS ONE FILE AND NOT TWO. `components/tp1-declaration-form.tsx` is rendered by BOTH the employee
 * screen (/me/tax-relief) and the HR admin-on-behalf screen (/payroll/transactions/tp1/[year]/[month]),
 * and each has its own server action. Before this round each action carried its OWN copy of the field
 * reader, and the two copies agreed only because someone kept them agreeing. With seventeen items, their
 * lettered sub-lines and a declaration tick, "agreed by hand" stops being a plan: a field read by one
 * action and not the other is a figure that silently drops on one of the two surfaces while tsc, the
 * suite and `next build` all stay green. So the field NAMES live here, next to the component that emits
 * them, and both actions call this.
 *
 * ── RULE 17: THE DECLARATION TICK IS READ BY VALUE, NEVER BY PRESENCE ───────────────────────────────
 * A hidden input is ALWAYS submitted. `formData.get('declarationAccepted') != null` is therefore TRUE for
 * an unticked box, which is the exact bug that rule exists to stop. The form renders a hidden `no` first
 * and the checkbox contributes `yes`, so this reads EVERY value under the name and asks whether 'yes' is
 * among them. Untick and the answer is a real, transmitted 'no'.
 *
 * ── THE CLIENT NEVER SENDS A TOTAL, AT ANY LEVEL ───────────────────────────────────────────────────
 * Not the grand total, and not an item's own total either. Only the individual boxes are read; the item
 * amount is the server's sum of its sub-lines and `tp1_amount` is the server's sum of the items
 * (core/tax-relief.ts). That is the line that keeps the PCB arithmetic byte-identical.
 */
// THROUGH THE PACK FACADE, not `core/tax-relief` directly (ADR-0080 D9/D11). The catalogue is payroll
// pack vocabulary, and test/payroll-pack-drift.test.ts fails the build for a new direct import — the
// allowlist only ever shrinks. `packs/payroll/service` re-exports exactly these.
import { TP1_ITEMS, TP1_REBATES } from '@/packs/payroll/service';
import { TP1_CATEGORY_KEYS } from '@/db/schema';

export type Tp1FormInput = {
  assessmentYear: number;
  deductionMonth: number | null;
  declarationAccepted: boolean;
  categories?: Record<string, unknown>;
  tp1Amount?: number;
};

/** The hidden marker the 2026 form renders. Its absence is what selects the legacy reader. */
export const TP1_FORM_MARKER = 'tp1-2026';

const num = (v: FormDataEntryValue | null): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export function readTp1FormInput(formData: FormData): Tp1FormInput {
  const assessmentYear = Number(formData.get('assessmentYear'));
  const rawMonth = formData.get('deductionMonth');
  const deductionMonth = rawMonth == null || String(rawMonth).trim() === '' ? null : Number(rawMonth);
  // RULE 17 — by VALUE. See the header.
  const declarationAccepted = formData.getAll('declarationAccepted').some((v) => String(v) === 'yes');

  const remarks = formData.get('remarks');
  const withRemarks = (categories: Record<string, unknown>) => {
    if (remarks != null) categories.remarks = String(remarks);
    return { assessmentYear, deductionMonth, declarationAccepted, categories };
  };

  if (String(formData.get('tp1Form') ?? '') === TP1_FORM_MARKER) {
    const group = (defs: typeof TP1_ITEMS, name: 'items' | 'rebates') => {
      const out: Record<string, { amount?: number; subItems?: Record<string, number> }> = {};
      for (const def of defs) {
        if (def.subItems.length === 0) {
          out[def.code] = { amount: num(formData.get(`tp1_${name}_${def.code}_amount`)) };
          continue;
        }
        const subItems: Record<string, number> = {};
        for (const sub of def.subItems) {
          subItems[sub.code] = num(formData.get(`tp1_${name}_${def.code}_sub_${sub.code}`));
        }
        out[def.code] = { subItems };
      }
      return out;
    };
    return withRemarks({
      form: TP1_FORM_MARKER,
      items: group(TP1_ITEMS, 'items'),
      rebates: group(TP1_REBATES, 'rebates'),
    });
  }

  // ── The pre-7ad37961 eight-key form, read exactly as it always was ────────────────────────────────
  const hasLegacyCategories = TP1_CATEGORY_KEYS.some((k) => formData.get(`cat_${k}`) != null);
  if (hasLegacyCategories) {
    const categories: Record<string, unknown> = {};
    for (const k of TP1_CATEGORY_KEYS) categories[k] = num(formData.get(`cat_${k}`));
    return withRemarks(categories);
  }
  // …and the scalar API/legacy path below that.
  return {
    assessmentYear,
    deductionMonth,
    declarationAccepted,
    tp1Amount: num(formData.get('tp1Amount')),
  };
}
