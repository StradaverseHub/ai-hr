'use server';

import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {getScopeIds} from '@/lib/scope';
import {allowedCompanies} from '@/core/read';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {isPayrollComparisonPeriod,previousPayrollComparisonPeriod} from '@/lib/payroll-period-comparison';
import {generateWorkforceAnalysis} from '@/core/ai-workforce-analysis';
import {generatePrivatePayrollComparisonAnalysis} from '@/core/ai-payroll-comparison-analysis';
import {payrollComparisonSpec} from '@/core/report-payroll-comparison';
import {generateDomainAnalysis} from '@/core/ai-domain-analysis';
import {AiPrivacyGateError} from '@/lib/ai/provider-privacy-request';
import {AiAllowanceError,AiGatewayError} from '@/lib/ai/types';

const input=z.object({domain:z.enum(['workforce','attendance','leave','payroll','claims','performance','rewards','organisation']),month:z.string().optional()}).strict();
export type ProtectedAnalysisDomain=z.infer<typeof input>['domain'];
export type ProtectedAnalysisNotice='invalid_request'|'privacy_unavailable'|'unavailable'|'temporarily_unavailable'|'failed';
export type ProtectedAnalysisResult={ok:true;text:string;scopeKey:string}|{ok:false;notice:ProtectedAnalysisNotice};
/** Explicit read-only command. Posted company/report/filter/provider data is never accepted. Native
 * services retain their fresh granular permissions and source validation on every actual admission. */
export async function readProtectedAnalysisAction(raw:unknown):Promise<ProtectedAnalysisResult>{
 const parsed=input.safeParse(raw);if(!parsed.success)return {ok:false,notice:'invalid_request'};
 const todayPeriod=todayInKualaLumpur().slice(0,7),month=parsed.data.month??previousPayrollComparisonPeriod(todayPeriod);
 if(!isPayrollComparisonPeriod(month)||month>=todayPeriod)return {ok:false,notice:'invalid_request'};
 // A month only applies to native monthly readers; snapshots never manufacture historical comparisons.
 const monthly=['workforce','attendance','payroll'].includes(parsed.data.domain);
 if(!monthly&&parsed.data.month!==undefined)return {ok:false,notice:'invalid_request'};
 try{
  const session=await getBrowserCommandSession();
  const available=await allowedCompanies(session),allowed=new Set(available.map(company=>company.id));
  const selected=await getScopeIds([...allowed]);
  if(!selected.length||selected.some(id=>!allowed.has(id)))return {ok:false,notice:'unavailable'};
  const companyIds=Object.freeze([...new Set(selected)].sort());
  let text:string;
  if(parsed.data.domain==='workforce')text=await generateWorkforceAnalysis(session,{companyIds,currentPeriod:month});
  else if(parsed.data.domain==='payroll')text=await generatePrivatePayrollComparisonAnalysis(session,payrollComparisonSpec(),companyIds,{currentPeriod:month});
  else text=await generateDomainAnalysis(session,{domain:parsed.data.domain,companyIds,...(parsed.data.domain==='attendance'?{month}:{})});
  if(typeof text!=='string'||!text.trim()||text.length>12000)return {ok:false,notice:'failed'};
  return {ok:true,text,scopeKey:JSON.stringify(companyIds)};
 }catch(error){
  // No provider, database, session or source diagnostic strings cross the browser boundary.
  return {ok:false,notice:error instanceof AiPrivacyGateError?'privacy_unavailable':error instanceof AiAllowanceError?'temporarily_unavailable':error instanceof AiGatewayError?'unavailable':'failed'};
 }
}
