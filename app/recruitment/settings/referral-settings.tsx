import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, Input, btnPrimary } from '@/components/ui';
import { referralSettings, REFERRAL_DAILY_LIMIT, REFERRAL_PROTECTION_MAX_DAYS } from '@/packs/recruitment/service';
import { updateReferralSettingsAction } from '../actions';

/**
 * Settings › Referrals (slice 7, administrators): the company's referral protection period. While it runs, a candidate
 * another employee referred cannot be referred again by someone else, so the first referrer keeps the credit; 0 switches
 * it off. Which jobs appear on the portal is set on each job (Job settings).
 */
export async function ReferralSettingsSection({ s, companyId, here }: { s: SessionContext; companyId: string; here: string }) {
  const [t, settings] = await Promise.all([getTranslations('recruitment.settings.referrals'), referralSettings(s, companyId)]);
  return (
    <form action={updateReferralSettingsAction} className="space-y-4 rounded-xl border border-border bg-card p-4">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="returnTo" value={here} />
      <div>
        <h2 className="text-base font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('note')}</p>
      </div>
      <Field label={t('protectionDays')} className="max-w-xs">
        <Input name="protectionDays" type="number" min={0} max={REFERRAL_PROTECTION_MAX_DAYS} required defaultValue={settings.protectionDays} />
      </Field>
      <p className="text-xs text-muted-foreground">{t('protectionNote', { max: REFERRAL_PROTECTION_MAX_DAYS })}</p>
      <p className="text-xs text-muted-foreground">{t('limitNote', { limit: REFERRAL_DAILY_LIMIT })}</p>
      <button type="submit" className={btnPrimary}>{t('save')}</button>
    </form>
  );
}
