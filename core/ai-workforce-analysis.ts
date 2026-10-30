import {createHash} from 'node:crypto';
import {types as nodeTypes} from 'node:util';
/** Native workforce analysis source. This is an explanation of the existing employment-headcount
 * owner, not a new HR calculator. Privacy support counts DISTINCT PEOPLE in both completed months.
 * Names, company IDs, period dates and exact counts stay local; no causal driver is invented.
 * The centralized disclosure review remains mandatory and may refuse this candidate. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {isAdmin} from '../lib/authz-model';
import {todayInKualaLumpur} from '../lib/hr-date';
import {isPayrollComparisonPeriod,previousPayrollComparisonPeriod} from '../lib/payroll-period-comparison';
import {AiGatewayError} from '../lib/ai/types';
import {PROVIDER_ANALYSIS_LIMITS} from '../lib/ai/provider-analysis-policy';
import {analysisCountChangeBand} from '../lib/ai/provider-analysis-bands';
import {payPeriodBounds} from './payslip-segment';
import {allowedCompanies} from './read';
import {assertReportPrincipalTx,masterReportFieldsTx} from './employee-master-access';
import {assertModuleEnabled,resolveEntitlementsTx} from './entitlements';
import {workforceHeadcountSourceTx,type WorkforceHeadcountSource} from './analytics';
import {resolveActiveAiConfig} from './ai-config';
import {generatePrivateAiAnalysis} from './ai-governance';

export type WorkforceAnalysisOptions=Readonly<{companyIds:readonly string[];currentPeriod?:string}>;
type Selection=Readonly<{companyIds:readonly string[];currentPeriod:string;previousPeriod:string;previousAsOf:string;currentAsOf:string}>;
const unavailable=():never=>{throw new AiGatewayError('Workforce analysis is unavailable for the current report scope.');};
/** Server callers pass their current selected company scope explicitly. No undefined/empty scope may
 * fall through to analytics' legacy all-visible-companies default. Caller references never survive. */
function selection(value:WorkforceAnalysisOptions):Selection{
 if(!value||typeof value!=='object'||nodeTypes.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return unavailable();
 const descriptors=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||!['companyIds','currentPeriod'].includes(key)))return unavailable();
 for(const descriptor of Object.values(descriptors))if(!descriptor.enumerable||!('value'in descriptor))return unavailable();
 const raw=descriptors.companyIds?.value;
 if(!Array.isArray(raw)||nodeTypes.isProxy(raw)||Object.getPrototypeOf(raw)!==Array.prototype||raw.length===0||raw.length>100)return unavailable();
 const elements=Object.getOwnPropertyDescriptors(raw);if(Reflect.ownKeys(elements).length!==raw.length+1)return unavailable();
 const ids=Array.from({length:raw.length},(_,index)=>{const descriptor=elements[String(index)];if(!descriptor||!('value'in descriptor)||typeof descriptor.value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(descriptor.value))return unavailable();return descriptor.value.toLowerCase();});
 if(new Set(ids).size!==ids.length)return unavailable();
 const suppliedPeriod=descriptors.currentPeriod?.value,todayPeriod=todayInKualaLumpur().slice(0,7);
 if(suppliedPeriod!==undefined&&typeof suppliedPeriod!=='string')return unavailable();
 const currentPeriod=suppliedPeriod===undefined?previousPayrollComparisonPeriod(todayPeriod):suppliedPeriod;
 if(!isPayrollComparisonPeriod(currentPeriod)||currentPeriod>=todayPeriod)return unavailable();
 const previousPeriod=previousPayrollComparisonPeriod(currentPeriod),previous=payPeriodBounds(previousPeriod),current=payPeriodBounds(currentPeriod);
 if(!isPayrollComparisonPeriod(previousPeriod)||!previous||!current)return unavailable();
 return Object.freeze({companyIds:Object.freeze(ids.sort()),currentPeriod,previousPeriod,previousAsOf:previous.to,currentAsOf:current.to});
}
async function authorizeSourceTx(tx:Tx,ctx:SessionContext,selected:Selection){
 await assertReportPrincipalTx(tx,ctx);
 if(!isAdmin(ctx)||!ctx.grants?.length||ctx.roles?.some(role=>!ctx.grants!.some(grant=>grant.role===role)))return unavailable();
 // A selected month can never include an unfinished current month, including at later replay.
 if(selected.currentPeriod>=todayInKualaLumpur().slice(0,7))return unavailable();
 const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId),entitlementsExempt:undefined,entitlementsError:undefined},available=new Set((await allowedCompanies(fresh,tx)).map(company=>company.id));
 if(selected.companyIds.some(id=>!available.has(id)))return unavailable();
 for(const companyId of selected.companyIds){
  const [admin]=await tx.execute<{allowed:boolean}>(sql`select (app.has_role_for('hr_admin',${companyId}::uuid) or app.has_role_for('super_admin',${companyId}::uuid)) as allowed`);
  if(admin?.allowed!==true)return unavailable();assertModuleEnabled(fresh,'employees',companyId);
 }
 // The granular native report resolver, not a broad admin OR, must allow personnel for EVERY company.
 const fields=await masterReportFieldsTx(tx,fresh,selected.companyIds);
 if(!fields.some(field=>field.owner==='employment'&&field.ownerField==='hiredOn'&&field.sensitivity==='personnel'&&field.report.enabled))return unavailable();
 return fresh;
}
function projection(source:WorkforceHeadcountSource){
 const counts=[source.previousHeadcount,source.currentHeadcount,source.previousPersons,source.currentPersons,source.unionPersons];
 if(counts.some(value=>!Number.isSafeInteger(value)||value<0)||source.previousPersons>source.previousHeadcount||source.currentPersons>source.currentHeadcount||
  source.unionPersons<Math.max(source.previousPersons,source.currentPersons)||source.unionPersons>source.previousPersons+source.currentPersons||
  Math.min(source.previousPersons,source.currentPersons)<PROVIDER_ANALYSIS_LIMITS.minimumPopulation||source.unionPersons>PROVIDER_ANALYSIS_LIMITS.maximumPopulation)return unavailable();
 return Object.freeze({version:1,domain:'workforce',window:'calendar_month',cohorts:Object.freeze([Object.freeze({cohort:'cohort_a',population:source.unionPersons,
  metrics:Object.freeze([Object.freeze({metric:'active_workforce',support:Math.min(source.previousPersons,source.currentPersons),changeBand:analysisCountChangeBand(source.previousHeadcount,source.currentHeadcount),
   drivers:Object.freeze([]),slices:Object.freeze([])})])})])});
}
/** Authorized source adoption for the real report_insight feature. Source reads and every replay use
 * the actual private-analysis admission transaction. The returned text remains untrusted explanation. */
export async function generateWorkforceAnalysis(supplied:SessionContext,options:WorkforceAnalysisOptions):Promise<string>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))},selected=selection(options);
 const configuration=await withTenant(ctx,async tx=>{const fresh=await authorizeSourceTx(tx,ctx,selected);return resolveActiveAiConfig(tx,fresh,'report_insight');});
 if(!configuration)return unavailable();
 let originalFingerprint:string|undefined;
 return generatePrivateAiAnalysis(configuration,async(tx,current)=>{
  await authorizeSourceTx(tx,current,selected);
  const source=await workforceHeadcountSourceTx(tx,selected.companyIds,{previousAsOf:selected.previousAsOf,currentAsOf:selected.currentAsOf});
  const fingerprint=createHash('sha256').update(JSON.stringify([selected,source])).digest('hex');
  if(originalFingerprint!==undefined&&originalFingerprint!==fingerprint)return unavailable();originalFingerprint=fingerprint;
  return projection(source);
 });
}
