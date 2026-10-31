import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { isAdmin, isGroupAdmin } from '@/lib/authz';
import { readLauncherSettings, LAUNCHER_POSITIONS } from '@/core/assistant-launcher';
import { PAGE_AREAS } from '@/lib/ai/page-context';
import { setAssistantLauncherAction } from './launcher-actions';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { loadAiGovernance } from '@/core/ai-workspace';
import { MODULE_JOBS } from '@/lib/ai/module-jobs';
import { Card, SectionHeader, btnPrimary } from '@/components/ui';
import { ModuleAgentReview } from '@/components/assistant/module-agent-review';
import { ModuleSpecialistReview } from '@/components/assistant/module-specialist-review';
import { HumanPlannerEvaluation } from '@/components/assistant/module-plan';
import { aiManagementHref } from './sections';
import type { AiManagementSearch } from './screen';

/** AI management › Assistant. One HR assistant with a specialist per HR module: which specialists are
 * available here, who may use the assistant, and the candidate reviews that used to sit on the employee
 * Assistant page. Availability follows the same rule the employee workspace uses (module entitlement;
 * System Analysis also needs an administrator). The reviews keep their owners' gates. */
export async function AiAssistantSection({session:s,searchParams}:{session:SessionContext;searchParams:Promise<AiManagementSearch>}) {
  const sp = await searchParams;
  const t = await getTranslations('aiManagement'), areas = await getTranslations('assistant.launcher.areas'), assistant = await getTranslations('assistant'), jobs = await getTranslations('assistant.workspace.jobs'), planning = await getTranslations('assistant.workspace.planning');
  const available = (code:string) => isModuleEnabledOrFalse(s,code) && (code!=='system_explorer' || isAdmin(s));
  const governance = await loadAiGovernance(s);
  // Closed codes only; a query string never puts its own words on this page.
  const status = sp.planning==='evaluated' ? planning('evaluated') : undefined;
  const alert = sp.error==='agent_review' ? assistant('err_agent_review') : sp.error==='launcher' ? t('launcherFailed') : sp.planning==='unavailable' ? planning('unavailable') : undefined;
  // An unreadable settings snapshot shows the switch as off; saving still goes through the owner's checks.
  let launcher: ReturnType<typeof readLauncherSettings> = { enabled: false, position: 'bottom-right', hiddenAreas: [] };
  try { launcher = readLauncherSettings(s); } catch { /* shown as off */ }
  const mayWrite = isGroupAdmin(s);
  return <div className="space-y-5">
    {status && <p role="status" className="rounded-md border border-border p-3 text-sm">{status}</p>}
    {alert && <p role="alert" className="rounded-md border border-border p-3 text-sm">{alert}</p>}
    <Card id="ai-specialists" className="scroll-mt-4 p-5">
      <SectionHeader title={t('specialistsTitle')}/>
      <p className="mt-1 max-w-4xl text-sm text-muted-foreground">{t('specialistsHelp')}</p>
      <ul className="mt-3 grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">{MODULE_JOBS.map(([code])=><li key={code} className="flex items-center justify-between gap-3 border-b border-border py-2 text-sm">
        <span className="min-w-0 break-words">{jobs(`module_${code}`)}</span>
        <span className={available(code)?'text-emerald-700 dark:text-emerald-300':'text-muted-foreground'}>{t(available(code)?'specialistAvailable':'specialistUnavailable')}</span>
      </li>)}</ul>
      <p className="mt-3 text-xs text-muted-foreground">{t('assistantAccessNote')} <Link href={aiManagementHref('allowances',{anchor:'#user-limits'})} className="font-medium text-primary hover:underline">{t('assistantAccessLink')}</Link></p>
    </Card>
    <Card id="ai-launcher" className="scroll-mt-4 p-5">
      <SectionHeader title={t('launcherTitle')}/>
      <p className="mt-1 max-w-4xl text-sm text-muted-foreground">{t('launcherHelp')}</p>
      {!mayWrite ? <p className="mt-3 text-sm">{t(launcher.enabled?'launcherOn':'launcherOff')} {t('launcherReadOnly')}</p>
      : <form action={setAssistantLauncherAction} className="mt-4 space-y-4">
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="enabled" value="yes" defaultChecked={launcher.enabled} className="size-4"/>{t('launcherEnabled')}</label>
        <fieldset className="space-y-2"><legend className="text-sm font-medium">{t('launcherPosition')}</legend>
          <div className="flex flex-wrap gap-4">{LAUNCHER_POSITIONS.map(position=><label key={position} className="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="position" value={position} defaultChecked={launcher.position===position} className="size-4"/>{t(position==='bottom-right'?'launcherRight':'launcherLeft')}</label>)}</div>
        </fieldset>
        <fieldset className="space-y-2"><legend className="text-sm font-medium">{t('launcherHidden')}</legend>
          <p className="text-xs text-muted-foreground">{t('launcherHiddenHelp')}</p>
          <div className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">{PAGE_AREAS.map(area=><label key={area} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="hidden" value={area} defaultChecked={launcher.hiddenAreas.includes(area)} className="size-4"/>{areas(area)}</label>)}</div>
        </fieldset>
        <p className="text-xs text-muted-foreground">{t('launcherVisibility')}</p>
        <button type="submit" className={btnPrimary}>{t('save')}</button>
      </form>}
    </Card>
    <section aria-labelledby="ai-reviews-heading" className="space-y-4">
      <div><h2 id="ai-reviews-heading" className="text-base font-semibold">{t('reviewsTitle')}</h2><p className="mt-1 max-w-4xl text-sm text-muted-foreground">{t('reviewsHelp')}</p></div>
      {!governance.access.allowed ? <p className="text-sm text-muted-foreground">{assistant(`denied_${governance.access.reason}`)}</p>
        : !governance.agentReview && !governance.specialistReview ? <p className="text-sm text-muted-foreground">{t('reviewsGroupOnly')}</p>
        : <>
          {governance.agentReview && <HumanPlannerEvaluation candidates={governance.agentReview.candidates}/>}
          {governance.agentReview && <ModuleAgentReview view={governance.agentReview}/>}
          {governance.specialistReview && <ModuleSpecialistReview view={governance.specialistReview}/>}
        </>}
    </section>
  </div>;
}
