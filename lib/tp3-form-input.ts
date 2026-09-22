/**
 * ONE reader for the LHDN TP3 (1/2026) previous-employment form (item df35d60d).
 *
 * WHY IT IS ITS OWN FILE, and the reasoning `lib/tp1-form-input.ts` records applies verbatim: the field
 * NAMES live next to nothing else, so the screen that EMITS them and the action that READS them cannot
 * drift. With two employers, five Section C lines (seven boxes) and seventeen Section D items with up to
 * six lettered boxes each, "agreed by hand" is not a plan — a field read by the emitter and not the
 * reader is a figure that silently drops while tsc, the suite and `next build` all stay green.
 *
 * ── RULE 17: THE DECLARATION TICK IS READ BY VALUE, NEVER BY PRESENCE ───────────────────────────────
 * A hidden input is ALWAYS submitted, so `formData.get('declarationAccepted') != null` is TRUE for an
 * unticked box. The form renders a hidden `no` first and the checkbox contributes `yes`; this reads
 * EVERY value under the name and asks whether 'yes' is among them. Untick and the answer is a real,
 * transmitted 'no'.
 *
 * ── THE CLIENT NEVER SENDS A TOTAL, AT ANY LEVEL ───────────────────────────────────────────────────
 * Not the Section C total, not an item's own total. Only the individual boxes are read; every item
 * amount is the server's sum of its sub-lines (core/tp3.ts `readGroup`). The same line that keeps the
 * TP1's arithmetic honest.
 */
// THROUGH THE PACK FACADE, not `core/tp3` directly (ADR-0080 D9/D11) — the catalogue is payroll pack
// vocabulary and test/payroll-pack-drift.test.ts fails the build for a new direct import.
import { TP3_MAX_EMPLOYERS, TP3_SECTION_C, TP3_SECTION_D } from '@/packs/payroll/service';

export type Tp3FormInput = {
  assessmentYear: number;
  deductionMonth: number | null;
  previousEmployers: { name: string; tin: string }[];
  sectionC: Record<string, { amount?: number; subItems?: Record<string, number> }>;
  sectionD: Record<string, { amount?: number; subItems?: Record<string, number> }>;
  declarationAccepted: boolean;
  remarks: string | null;
};

/** The hidden marker the TP3 form renders, so a post that is not this form is not read as one. */
export const TP3_FORM_MARKER = 'tp3-2026';

const num = (v: FormDataEntryValue | null): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Section A field names. Exported so the component and the tests spell them once. */
export const employerNameField = (i: number) => `tp3_employer_${i}_name`;
export const employerTinField = (i: number) => `tp3_employer_${i}_tin`;
/** Section C / D box names. `group` is 'c' or 'd'; `sub` is the roman numeral or the letter. */
export const amountField = (group: 'c' | 'd', code: string) => `tp3_${group}_${code}_amount`;
export const subField = (group: 'c' | 'd', code: string, sub: string) => `tp3_${group}_${code}_sub_${sub}`;

export function readTp3FormInput(formData: FormData): Tp3FormInput {
  const assessmentYear = Number(formData.get('assessmentYear'));
  const rawMonth = formData.get('deductionMonth');
  const deductionMonth = rawMonth == null || String(rawMonth).trim() === '' ? null : Number(rawMonth);
  // RULE 17 — by VALUE. See the header.
  const declarationAccepted = formData.getAll('declarationAccepted').some((v) => String(v) === 'yes');

  // EXACTLY the pairs the form is RULED FOR, read from the pack rather than from a literal 2 here. A
  // third pair posted by hand is simply not read — and the service refuses one that arrives another way,
  // so the two halves of the contract agree rather than one of them silently winning.
  const previousEmployers = Array.from({ length: TP3_MAX_EMPLOYERS }, (_, i) => ({
    name: String(formData.get(employerNameField(i + 1)) ?? ''),
    tin: String(formData.get(employerTinField(i + 1)) ?? ''),
  }));

  const group = (
    defs: readonly { code: string; subItems: readonly { code: string }[] }[],
    g: 'c' | 'd',
  ) => {
    const out: Record<string, { amount?: number; subItems?: Record<string, number> }> = {};
    for (const def of defs) {
      if (def.subItems.length === 0) {
        out[def.code] = { amount: num(formData.get(amountField(g, def.code))) };
        continue;
      }
      const subItems: Record<string, number> = {};
      for (const sub of def.subItems) subItems[sub.code] = num(formData.get(subField(g, def.code, sub.code)));
      out[def.code] = { subItems };
    }
    return out;
  };

  const remarksRaw = formData.get('remarks');

  return {
    assessmentYear,
    deductionMonth,
    previousEmployers,
    sectionC: group(TP3_SECTION_C, 'c'),
    sectionD: group(TP3_SECTION_D, 'd'),
    declarationAccepted,
    remarks: remarksRaw == null ? null : String(remarksRaw),
  };
}
