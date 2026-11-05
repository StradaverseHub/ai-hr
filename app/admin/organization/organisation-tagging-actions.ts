'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {prepareCompanyOrganisationRun,decideCompanyOrganisationRun,processCompanyOrganisationRun,type CompanyOrganisationRunInput} from '@/core/company-organisation';
import {isCalendarDate} from '@/lib/calendar-date';
const uuid=(value:unknown)=>{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw Error('Invalid organisation identity.');return value;};
export async function prepareOrganisationAction(form:FormData){
 const s=await getSession();const kind=String(form.get('kind'));const effectiveOn=String(form.get('effectiveOn'));
 if(!['mapping','restructure','retag'].includes(kind)||!isCalendarDate(effectiveOn))throw Error('Invalid organisation proposal.');
 const companyIds=form.getAll('companyId').map(uuid);if(!companyIds.length||companyIds.length>500)throw Error('Choose the companies to include.');
 const changes=kind==='retag'?[]:companyIds.map(companyId=>({companyId,businessUnitId:form.get(`bu:${companyId}`)?uuid(form.get(`bu:${companyId}`)):null,parentCompanyId:form.get(`parent:${companyId}`)?uuid(form.get(`parent:${companyId}`)):null}));
 const id=await prepareCompanyOrganisationRun(s,{kind:kind as CompanyOrganisationRunInput['kind'],effectiveOn,companyIds,changes});
 redirect(`/admin/organization/organisation-tagging?runId=${id}`);
}
export async function decideOrganisationAction(form:FormData){
 const s=await getSession(),id=uuid(form.get('runId'));const decision=form.get('decision');if(decision!=='approve'&&decision!=='reject')throw Error('Choose an explicit decision.');
 await decideCompanyOrganisationRun(s,{id,digest:String(form.get('digest')),approve:decision==='approve',reason:String(form.get('reason')??'')});
 revalidatePath('/admin/organization');redirect(`/admin/organization/organisation-tagging?runId=${id}`);
}
export async function processOrganisationAction(form:FormData){
 const s=await getSession(),id=uuid(form.get('runId'));await processCompanyOrganisationRun(s,id);
 revalidatePath('/admin/organization');revalidatePath('/personnel');redirect(`/admin/organization/organisation-tagging?runId=${id}`);
}
