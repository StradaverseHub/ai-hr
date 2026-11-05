import {companyOrganisationOptions,companyOrganisationRuns} from '@/core/company-organisation';
import type {SessionContext} from '@/db/client';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {OrganisationTaggingEditor} from './organisation-tagging-controls';
import {prepareOrganisationAction} from './organisation-tagging-actions';
import {getTranslations} from 'next-intl/server';
export async function OrganisationTaggingWorkspace({session}:{session:SessionContext}){
 const [options,runs,t]=await Promise.all([companyOrganisationOptions(session),companyOrganisationRuns(session),getTranslations('organisationTagging')]);
 return <section className="space-y-3"><OrganisationTaggingEditor options={options} today={todayInKualaLumpur()} prepareAction={prepareOrganisationAction}/>{runs.length>0&&<ul className="flex flex-wrap gap-3 text-sm">{runs.map(run=><li key={run.id}><a className="underline" href={`/admin/organization/organisation-tagging?runId=${run.id}`}>{run.effectiveOn} · {t(`states.${run.state}`)} · {run.id.slice(0,8)}</a></li>)}</ul>}</section>;
}
