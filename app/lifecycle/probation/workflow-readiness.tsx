import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import type {probationRequiredWorkflowStatus} from '@/packs/probation/service';

type CompanyStatus={id:string;status:Awaited<ReturnType<typeof probationRequiredWorkflowStatus>>};

export async function WorkflowReadiness({companies}:{companies:CompanyStatus[]}){
 const warnings=companies.filter(({status})=>status&&(status.missing.length>0||!status.summaryReady));
 if(!warnings.length)return null;
 const t=await getTranslations('probation');
 return <section className="v9-panel v9-stack" aria-label={t('workflowReadiness.title')}>
  <h2>{t('workflowReadiness.title')}</h2>
  <p>{t('workflowReadiness.help')}</p>
  <ul className="v9-list">{warnings.map(({id,status})=>status&&<li key={id}>
   {status.canConfigure?<Link href={'/lifecycle/probation/workflows?company='+encodeURIComponent(id)}>{status.companyName}</Link>:<strong>{status.companyName}</strong>}
   {status.missing.length>0&&<p>{status.missing.map(event=>t('workflows.events.'+event)).join(' · ')}</p>}
   {!status.summaryReady&&<p>{t('workflowReadiness.summary')}</p>}
  </li>)}</ul>
 </section>;
}
