import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { btnGhost } from '@/components/ui';
import { matchSummarySetting } from '@/packs/recruitment/service';
import { updateMatchSummarySettingAction } from '../actions';
import { Pill } from '../shared';

/**
 * Settings › AI match summaries (slice 24, administrators): the company's switch (default off). While the owner has not recorded the
 * provider-data approval the section says so and nobody is offered the button, whatever the switch says.
 */
export async function AiSettingsSection({ s, companyId, here }: { s: SessionContext; companyId: string; here: string }) {
  const [t, setting] = await Promise.all([getTranslations('recruitment.matchSummary'), matchSummarySetting(s, companyId)]);
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted-foreground">{t('settingsNote')}</p>
      {!setting.approved && (
        <p role="status" className="max-w-3xl rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">{t('notApproved')}</p>
      )}
      <form action={updateMatchSummarySettingAction} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
        <input type="hidden" name="companyId" value={companyId} />
        <input type="hidden" name="returnTo" value={here} />
        <label className="flex min-w-0 flex-1 items-start gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={setting.on} className="mt-0.5 accent-primary" />
          <span><span className="font-medium">{t('settingLabel')}</span><span className="block text-xs text-muted-foreground">{t('settingHelp')}</span></span>
        </label>
        <Pill tone={setting.on ? 'good' : 'neutral'}>{setting.on ? t('on') : t('off')}</Pill>
        <button type="submit" className={btnGhost}>{t('save')}</button>
      </form>
      <div className="max-w-3xl space-y-1 text-sm">
        <h3 className="font-medium">{t('sentTitle')}</h3>
        <p className="text-muted-foreground">{t('sent')}</p>
        <h3 className="pt-2 font-medium">{t('neverSentTitle')}</h3>
        <p className="text-muted-foreground">{t('neverSent')}</p>
      </div>
    </div>
  );
}
