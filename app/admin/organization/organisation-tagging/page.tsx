import {notFound} from 'next/navigation';
import {getSession} from '@/lib/session';
import {companyOrganisationRunReport} from '@/core/company-organisation';
import {OrganisationTaggingReview} from '../organisation-tagging-controls';
import {decideOrganisationAction,processOrganisationAction} from '../organisation-tagging-actions';
import {pageWideCls} from '@/components/ui';
// Narrow run review deliberately precedes any HR catalogue guard. SQL admits an exact independent checker.
export default async function OrganisationReviewPage({searchParams}:{searchParams:Promise<{runId?:string;offset?:string}>}){
 const session=await getSession();
 const {runId,offset:offsetParam}=await searchParams;
 if(typeof runId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId))notFound();
 const offset=Math.max(0,Number.parseInt(offsetParam??'0',10)||0);
 const report=await companyOrganisationRunReport(session,runId,offset);
 return <div className={pageWideCls}><OrganisationTaggingReview report={report} offset={offset} decideAction={decideOrganisationAction} processAction={processOrganisationAction}/></div>;
}
