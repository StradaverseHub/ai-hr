'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {scopedSession} from '@/lib/scope';
import {allowedCompanies} from '@/core/read';
import {setOrgChartRoot,OrgChartRootError} from '@/core/org-chart';
export async function designateRoot(form:FormData){
 const {s}=await scopedSession();const scopeIds=(await allowedCompanies(s)).map(company=>company.id);const employmentId=String(form.get('employmentId')??'');
 const {orgChartSnapshot}=await import('@/core/org-chart');const snapshot=await orgChartSnapshot(s,{companyIds:scopeIds,filter:{asOf:String(form.get('validFrom')??'')}});
 if(!snapshot.canManage||!snapshot.employees.some(e=>e.employmentId===employmentId))throw new Error('Organisation maintenance is unavailable');
 const params=new URLSearchParams({asOf:String(form.get('validFrom')??'')});const companyId=String(form.get('companyId')??'');if(scopeIds.includes(companyId))params.set('companyId',companyId);
 try{await setOrgChartRoot(s,{employmentId,validFrom:String(form.get('validFrom')??''),enabled:form.get('enabled')==='true'});}catch(error){if(error instanceof OrgChartRootError){params.set('notice',error.code);redirect('/org?'+params);}throw error;}
 revalidatePath('/org');params.set('notice','saved');redirect('/org?'+params);
}
