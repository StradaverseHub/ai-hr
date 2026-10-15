import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { ASSESSMENT_AI_FEATURES, getAssessmentAiSwitches } from '@/packs/performance/service';
import { Button, Card } from '@/components/ui';
import { setAssessmentAiSwitchAction } from './actions';

export async function AssessmentAiSettings({ session }: { session: SessionContext }) {
  const t = await getTranslations('admin.ai.assessment');
  const state = await getAssessmentAiSwitches(session);
  return <Card className="p-5">
    <h2 className="text-base font-semibold">{t('title')}</h2>
    <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
    {!state.mayWrite && <p className="mt-3 text-sm text-muted-foreground">{t('readOnly')}</p>}
    <ul className="mt-3 divide-y divide-border">
      {ASSESSMENT_AI_FEATURES.map(feature => <li key={feature} className="flex items-center justify-between gap-4 py-3">
        <div className="min-w-0"><p className="text-sm font-medium">{t(`features.${feature}`)}</p><p className="mt-1 text-xs text-muted-foreground">{t(!state.switches[feature] ? 'off' : state.moduleHeld===false ? 'moduleMissing' : state.providerConfigured ? 'on' : 'providerMissing')}</p></div>
        {state.mayWrite && <form action={setAssessmentAiSwitchAction}>
          <input type="hidden" name="feature" value={feature}/>
          <input type="hidden" name="on" value={String(!state.switches[feature])}/>
          <Button type="submit" variant="secondary" aria-label={t(state.switches[feature] ? 'turnOffFeature' : 'turnOnFeature', { feature: t(`features.${feature}`) })}>{t(state.switches[feature] ? 'turnOff' : 'turnOn')}</Button>
        </form>}
      </li>)}
    </ul>
  </Card>;
}
