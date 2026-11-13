import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {requireModule} from '@/lib/authz';
import {rewardOffcycleSettings,RewardError} from '@/packs/rewards/service';
import {Card,PageHeader} from '@/components/ui';
import {OffcycleYearForm} from './year-form';

/** b945f0cc: Group Rewards opens a cycle's off-cycle year (after final EC approval and the payroll hand-off of every
 * year-end review) and sets the mid-year submission window. Everyone else gets "You don't have access". */
export default async function OffcycleSettingsPage(){
 await requireModule('rewards');const {s}=await scopedSession();const t=await getTranslations('rewardDashboard');
 let cycles:Awaited<ReturnType<typeof rewardOffcycleSettings>>|null=null;
 try{cycles=await rewardOffcycleSettings(s);}catch(e){if(!(e instanceof RewardError))throw e;}
 return <div className="w-full max-w-3xl space-y-5"><Link href="/rewards" className="text-sm text-primary hover:underline">← {t('offcycle.back')}</Link>
  <PageHeader title={t('offcycle.settings')} description={t('offcycle.settingsHelp')}/>
  {!cycles?<p role="alert" className="rounded-md border border-border p-4 text-sm">{t('offcycle.noAccess')}</p>
   :cycles.length?cycles.map(cycle=><Card key={cycle.cycleId} className="space-y-3 p-5"><h2 className="font-semibold">{cycle.name}</h2>
    <p className="text-sm text-muted-foreground">{cycle.revision?t('offcycle.openSince',{date:cycle.openedAt?.slice(0,10)??''}):t('offcycle.readiness',{posted:cycle.readiness.posted,open:cycle.readiness.open})}</p>
    <OffcycleYearForm cycleId={cycle.cycleId} revision={cycle.revision} canOpen={cycle.canOpen} midyearFrom={cycle.midyearFrom} midyearTo={cycle.midyearTo}/></Card>)
   :<p className="text-sm text-muted-foreground">{t('offcycle.noCycles')}</p>}
 </div>;
}
