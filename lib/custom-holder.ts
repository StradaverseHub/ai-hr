/**
 * THE CUSTOM PAYMENT HOLDER — the one rule and its typed refusal, CLIENT-SAFE (no DB imports).
 *
 * r393 (item 685d2380 step 3a) moved these here from localization/my/statutory.ts, which still re-exports
 * the error, because three readers now need the SAME answer and one of them runs in the browser — the
 * same move step 2 made for `bankTransferLacksBank` (lib/payment-methods.ts):
 *   - `setBankProfileMY` (= `pack.statutory.setBank`) — refuses a tick with a blank value;
 *   - `missingByTab` (lib/employee-draft-schema.ts) — names the same gap on a DRAFT's Bank & Statutory
 *     tab, so Activate stays switched off until the box is filled or the tick is taken off;
 *   - `completeEmployeeDraft` (core/employee-draft.ts) — refuses the same draft BEFORE `hireEmployee`,
 *     with the same typed error, because `setBank` can only run after the employee exists.
 * A second copy of the predicate on any of the three is how a draft would show nothing outstanding and
 * then be refused by the writer after the employee had already been created.
 */

/** A custom-holder switch was turned on without its required value (item ef720d3a). `field` names which. */
export class IncompleteCustomHolderError extends Error {
  constructor(public field: 'name' | 'id') {
    super(
      field === 'name'
        ? 'Enter the custom holder name, or turn off "Use a custom holder name".'
        : 'Enter the custom holder identification, or turn off "Use a custom holder identification".',
    );
    this.name = 'IncompleteCustomHolderError';
  }
}

export type CustomHolder = {
  enableCustomHolderName?: boolean;
  customHolderName?: string | null;
  enableCustomHolderId?: boolean;
  customHolderId?: string | null;
};

/**
 * Which ticked holder boxes are still BLANK (judged after trimming), name first. Empty when nothing is
 * outstanding. A box whose tick is off is never a gap — its value is not carried anywhere.
 */
export function customHolderGaps(h: CustomHolder): Array<'name' | 'id'> {
  const gaps: Array<'name' | 'id'> = [];
  if (h.enableCustomHolderName && !(h.customHolderName ?? '').trim()) gaps.push('name');
  if (h.enableCustomHolderId && !(h.customHolderId ?? '').trim()) gaps.push('id');
  return gaps;
}
