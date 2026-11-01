/** Public audit references contain no payroll figures or administrative batch details. */
export type TaxBasisNoticeReference = {batchId: string; reference: string; canOpen: boolean};
export type TaxBasisNoticeStrings = {description: string; references: string; view: string};

export function taxBasisNoticeBatchIds(references: unknown): string[] {
  if (!Array.isArray(references)) return [];
  const ids = references.flatMap(reference => {
    const id = reference && typeof reference === 'object' ? reference.batchId : null;
    return typeof id === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id) ? [id.toLowerCase()] : [];
  });
  return [...new Set(ids)];
}
