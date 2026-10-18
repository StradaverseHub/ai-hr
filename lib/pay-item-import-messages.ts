/** Stable domain codes become the same localized explanation in the preview and error workbook. */
export function payItemIssueMessage(code: string, t: (key: string) => string, rule: (key: string) => string): string {
  if (['pcbRemunerationTypeRequired', 'pcbExemptionTypeRequired', 'pcbExemptionTypeInvalid', 'epfBonusRequiresEpf'].includes(code)) return t(`errorStatutory_${code}`);
  if (['PRORATION_CONFLICT', 'STATUTORY_FORBIDDEN', 'BAD_KIND', 'OUT_OF_RANGE', 'UNKNOWN_COMPONENT', 'SELF_REFERENCE', 'CYCLE', 'UNSAFE_DIVISION', 'TOO_MANY_TERMS', 'BAD_OPERAND', 'BAD_OPERATOR'].includes(code)) return rule(`errors.${code}`);
  const supported = ['required', 'invalidCode', 'tooLong', 'invalidChoice', 'formulaNotAllowed', 'existingCode', 'duplicateCode', 'pcbFieldsRequirePcb', 'invalidPendingCalculation', 'calculationRequired', 'nonCashContributionFlags', 'deductionOrp', 'calculationProrates', 'unmappedEarning', 'valid', 'classification_conflict', 'unsupported_kind', 'normal_remuneration_required', 'unrecognised_taxable_item'];
  return t(`importIssue_${supported.includes(code) ? code : 'configuration'}`);
}
