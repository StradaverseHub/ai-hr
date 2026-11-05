import {getSession} from '@/lib/session';
import {companyOrganisationRunReport} from '@/core/company-organisation';
import {OrganisationTaggingReview} from '../organisation-tagging-controls';
import {decideOrganisationAction,processOrganisationAction} from '../organisation-tagging-actions';
import {pageWideCls} from '@/components/ui';
// Narrow run review deliberately precedes any HR catalogue guard. SQL admits an exact independent checker.
export default async function OrganisationReviewPage({searchParams}:{searchParams:Promise<{runId?:string;offset?:string}>}){
 const s=await getSession(),sp=await searchParams;if(!sp.runId||!/^[0-9a-f-]{36}$/i.test(sp.runId))throw Error('Organisation run is unavailable.');
 const offset=Math.max(0,Number.parseInt(sp.offset??'0',10)||0),report=await companyOrganisationRunReport(s,sp.runId,offset);
 return <div className={pageWideCls}><OrganisationTaggingReview report={report} offset={offset} decideAction={decideOrganisationAction} processAction={processOrganisationAction}/></div>;
}
