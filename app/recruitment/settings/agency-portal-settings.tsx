import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { btnGhost } from '@/components/ui';
import { agencyPortalSetting, candidateEmailSettings } from '@/packs/recruitment/service';
import { updateAgencyPortalSettingAction } from '../actions';
import { Pill } from '../shared';

/**
 * Settings › Agency portal (slice 25, administrators): the company's switch (default off), the portal's address, and what it needs:
 * a published careers page and candidate e-mail switched on (the sign-in code is sent with the company's sender and reply-to).
 */
export async function AgencyPortalSettingsSection({ s, companyId, here }: { s: SessionContext; companyId: string; here: string }) {
  const [t, setting, email] = await Promise.all([getTranslations('recruitment.agencyPortalSettings'), agencyPortalSetting(s, companyId),
    candidateEmailSettings(s, companyId).catch(() => null)]);
  const emailOn = email?.enabled === true && email.available;
  const path = setting.address ? `/careers/${setting.address}/agency` : null;
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted-foreground">{t('note')}</p>
      <form action={updateAgencyPortalSettingAction} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
        <input type="hidden" name="companyId" value={companyId} />
        <input type="hidden" name="returnTo" value={here} />
        <label className="flex min-w-0 flex-1 items-start gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={setting.on} className="mt-0.5 accent-primary" />
          <span><span className="font-medium">{t('label')}</span><span className="block text-xs text-muted-foreground">{t('help')}</span></span>
        </label>
        <Pill tone={setting.on ? 'good' : 'neutral'}>{setting.on ? t('on') : t('off')}</Pill>
        <button type="submit" className={btnGhost}>{t('save')}</button>
      </form>
      <ul className="max-w-3xl space-y-1 text-sm">
        <li>{path ? t('address', { path }) : t('noCareersPage')}</li>
        {!emailOn && <li className="text-amber-700 dark:text-amber-400">{t('noEmail')}</li>}
      </ul>
      <p className="max-w-3xl text-sm text-muted-foreground">{t('how')}</p>
    </div>
  );
}
