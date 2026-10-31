import {notFound} from 'next/navigation';
import {requireModule} from '@/lib/authz';
import {scopedSession} from '@/lib/scope';
import {letterCompanyAccess,getLetterPolicy,readLetterSettingsReadiness} from '@/core/letters';
import {LetterWorkflowError} from '@/lib/letter-workflow';
import {Card,PageHeader,pageWideCls} from '@/components/ui';
import {LetterPolicyForm} from '@/components/letters/settings-forms';
import {settingsLabels} from '../labels';
export const dynamic='force-dynamic';
export default async function LetterPolicySettingsPage({searchParams}:{searchParams:Promise<{companyId?:string;category?:string;notice?:string}>}){
 await requireModule('employees');const {s,scopeIds}=await scopedSession(),sp=await searchParams,labels=await settingsLabels(),refused=(error:unknown):never=>{if(error instanceof LetterWorkflowError&&['invalid','permission'].includes(error.code))notFound();throw error;};
 const company=(await letterCompanyAccess(s)).find(company=>company.id===sp.companyId&&scopeIds.includes(company.id)&&company.settings);if(!company)notFound();
 const data=sp.category?await getLetterPolicy(s,{companyId:company.id,category:sp.category}).catch(refused):null;if(sp.category&&!data)notFound();const readiness=await readLetterSettingsReadiness(s,company.id).catch(refused),initial=data?{category:data.category,ordinal:data.ordinal,enabled:data.enabled,policy:data.policy,people:data.people,appearance:data.appearance}:undefined;
 return <div className={pageWideCls}><PageHeader title={data?data.category:labels.copy.newPolicy} description={company.name+(data?' · '+labels.version(data.ordinal):'')} back={{href:'/letters/settings?companyId='+company.id,label:labels.copy.title}}/>{sp.notice==='saved'&&<p role="status" className="rounded-md border p-4 text-sm">{labels.copy.saved}</p>}<Card className="p-5"><LetterPolicyForm key={company.id+':'+(data?.id??'new')} companyId={company.id} initial={initial} readiness={readiness} labels={labels.copy} common={labels.common} picker={labels.picker} errors={labels.errors}/></Card></div>;
}
