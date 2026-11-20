import {notFound,redirect} from 'next/navigation';
import {z} from 'zod';
import {getSession} from '@/lib/session';
import {pgSqlState} from '@/lib/db-error';
import {companyOrganisationRunReport} from '@/core/company-organisation';
import {OrganisationTaggingReview} from '../organisation-tagging-controls';
import {decideOrganisationAction,processOrganisationAction} from '../organisation-tagging-actions';
import {pageWideCls} from '@/components/ui';

const runIdentifier=z.guid();

// The native report admits an exact independent checker, including a checker without the HR catalogue role.
export default async function OrganisationReviewPage({searchParams}:{
 searchParams:Promise<{runId?:string|string[];offset?:string|string[]}>;
}){
 const {runId,offset:offsetParam}=await searchParams;
 if(runId===undefined)redirect('/admin/organization');
 const identifier=runIdentifier.safeParse(runId);
 if(!identifier.success)notFound();

 const session=await getSession();
 const offset=Math.max(0,Number.parseInt(typeof offsetParam==='string'?offsetParam:'0',10)||0);
 const report=await companyOrganisationRunReport(session,identifier.data,offset).catch(error=>{
  if(pgSqlState(error)==='42501')notFound();
  throw error;
 });
 return <div className={pageWideCls}>
  <OrganisationTaggingReview report={report} offset={offset} decideAction={decideOrganisationAction} processAction={processOrganisationAction}/>
 </div>;
}
