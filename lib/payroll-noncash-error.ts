import { getTranslations } from 'next-intl/server';

export const NONCASH_CONFIGURATION_REASONS = new Set([
  'classification_conflict', 'unsupported_kind', 'normal_remuneration_required', 'month_baseline_unavailable',
]);

/** Consume a stable public refusal, never expose component names or raw calculation errors. */
export async function payrollNonCashErrorMessage(error: unknown): Promise<string | null> {
  if (!(error instanceof Error) || error.name !== 'NonCashBenefitConfigurationError'
    || !('code' in error) || error.code !== 'pcb_non_cash_configuration_invalid') return null;
  const t = await getTranslations('payroll.process');
  const reason = 'reason' in error ? String(error.reason) : '';
  return t(NONCASH_CONFIGURATION_REASONS.has(reason) ? `nonCash_${reason}` : 'nonCash_configuration_invalid');
}
