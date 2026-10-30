import {createHash} from 'node:crypto';
import {types as nodeTypes} from 'node:util';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {isAdmin} from '../lib/authz-model';
import {AiGatewayError} from '../lib/ai/types';
import {todayInKualaLumpur} from '../lib/hr-date';
import {isPayrollComparisonPeriod,previousPayrollComparisonPeriod} from '../lib/payroll-period-comparison';
import {allowedCompanies,leaveAnalysisSourceTx} from './read';
import {assertReportPrincipalTx,masterReportFieldsTx} from './employee-master-access';
import {assertModuleEnabled,resolveEntitlementsTx} from './entitlements';
import {attendanceAnalysisSourceTx} from '../packs/attendance/service';
import {claimsAnalysisSourceTx} from '../packs/claims/service';
import {performanceAnalysisSourceTx} from '../packs/performance/service';
import {rewardsAnalysisSourceTx} from '../packs/rewards/service';
import {organisationAnalysisSourceTx} from './hr-orchestrator';
import {resolveActiveAiConfig} from './ai-config';
import {generatePrivateAiTaskAnalysis} from './ai-governance';

const definitions={
 attendance:{module:'attendance',metrics:['lateness_prevalence','absence_prevalence'],all:false},
 leave:{module:'leave',metrics:['pending_request_share'],all:false},
 claims:{module:'claims',metrics:['pending_claim_share'],all:false},
 performance:{module:'performance',metrics:['review_completion'],all:true},
 rewards:{module:'rewards',metrics:['facts_verification_share'],all:true},
 organisation:{module:'org',metrics:['open_workload'],all:false},
} as const;
export type AnalysisDomain=keyof typeof definitions;
export type DomainAnalysisOptions=Readonly<{domain:AnalysisDomain;companyIds:readonly string[];month?:string;cycleId?:string;rewardUnitId?:string}>;
type NativeSource={selection:string;rows:{personId:string;conditions:Record<string,boolean>}[]};
const unavailable=():never=>{throw new AiGatewayError('Analysis is unavailable for the current source, report scope or privacy support.');};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function selection(value:DomainAnalysisOptions):DomainAnalysisOptions{
 if(!value||typeof value!=='object'||nodeTypes.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return unavailable();
 const descriptors=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||!['domain','companyIds','month','cycleId','rewardUnitId'].includes(key)))return unavailable();
 for(const descriptor of Object.values(descriptors))if(!descriptor.enumerable||!('value'in descriptor))return unavailable();
 const domain=descriptors.domain?.value;if(typeof domain!=='string'||!Object.hasOwn(definitions,domain))return unavailable();
 const raw=descriptors.companyIds?.value;
 if(!Array.isArray(raw)||nodeTypes.isProxy(raw)||Object.getPrototypeOf(raw)!==Array.prototype||!raw.length||raw.length>100)return unavailable();
 const elements=Object.getOwnPropertyDescriptors(raw);if(Reflect.ownKeys(elements).length!==raw.length+1)return unavailable();
 const ids=Array.from({length:raw.length},(_,index)=>{const d=elements[String(index)];if(!d||!('value'in d)||!uuid(d.value))return unavailable();return d.value.toLowerCase();});
 if(new Set(ids).size!==ids.length)return unavailable();
 const cycleId=descriptors.cycleId?.value,rewardUnitId=descriptors.rewardUnitId?.value,month=descriptors.month?.value;
 if(cycleId!==undefined&&(domain!=='performance'||!uuid(cycleId)))return unavailable();
 if(rewardUnitId!==undefined&&(domain!=='rewards'||!uuid(rewardUnitId)))return unavailable();
 if(month!==undefined&&(domain!=='attendance'||!isPayrollComparisonPeriod(month)||month>=todayInKualaLumpur().slice(0,7)))return unavailable();
 return Object.freeze({domain:domain as AnalysisDomain,companyIds:Object.freeze(ids.sort()),
  ...(domain==='attendance'?{month:month??previousPayrollComparisonPeriod(todayInKualaLumpur().slice(0,7))}:{}),
  ...(cycleId?{cycleId}:{}),...(rewardUnitId?{rewardUnitId}:{})});
}
async function authorizeSourceTx(tx:Tx,ctx:SessionContext,selected:DomainAnalysisOptions){
 await assertReportPrincipalTx(tx,ctx);
 if(!isAdmin(ctx)||!ctx.grants?.length||ctx.roles?.some(role=>!ctx.grants!.some(grant=>grant.role===role)))return unavailable();
 if(selected.month&&selected.month>=todayInKualaLumpur().slice(0,7))return unavailable();
 const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId),entitlementsExempt:undefined,entitlementsError:undefined};
 const allowed=new Set((await allowedCompanies(fresh,tx)).map(company=>company.id));
 if(selected.companyIds.some(id=>!allowed.has(id)))return unavailable();
 for(const companyId of selected.companyIds){
  const [admin]=await tx.execute<{allowed:boolean}>(sql`select (app.has_role_for('hr_admin',${companyId}::uuid) or app.has_role_for('super_admin',${companyId}::uuid)) as allowed`);
  if(admin?.allowed!==true)return unavailable();assertModuleEnabled(fresh,definitions[selected.domain].module,companyId);
 }
 const fields=await masterReportFieldsTx(tx,fresh,selected.companyIds);
 if(!fields.some(field=>field.owner==='employment'&&field.ownerField==='hiredOn'&&field.sensitivity==='personnel'&&field.report.enabled))return unavailable();
 return fresh;
}
/** Counts PERSONS, never cases, employments or review entries. All-condition metrics require every native
 * entry belonging to the person; any-condition metrics require at least one. Exact IDs stay local.
 * 20/5 are provisional conservative suppression thresholds, not an anonymity claim. */
export function domainAnalysisProjection(domain:AnalysisDomain,source:NativeSource){
 const definition=definitions[domain];if(!definition||!source.rows.length||source.rows.length>100000)return unavailable();
 const people=new Map<string,Record<string,boolean>>();
 for(const row of source.rows){
  if(!uuid(row.personId)||Object.keys(row.conditions).length!==definition.metrics.length||Object.keys(row.conditions).some(key=>!(definition.metrics as readonly string[]).includes(key)))return unavailable();
  const prior=people.get(row.personId);
  const conditions:Record<string,boolean>={};
  for(const metric of definition.metrics){const value=row.conditions[metric];if(typeof value!=='boolean')return unavailable();
   conditions[metric]=prior?(definition.all?prior[metric]&&value:prior[metric]||value):value;}
  people.set(row.personId,conditions);
 }
 const population=people.size;if(population<20||population>100000)return unavailable();
 const metrics=definition.metrics.map(metric=>{
  const numeratorPeople=[...people.values()].filter(row=>row[metric]).length,complement=population-numeratorPeople;
  if((numeratorPeople>0&&numeratorPeople<5)||(complement>0&&complement<5))return unavailable();
  return {metric,support:population,numeratorPeople,slices:[]};
 });
 return {version:1,domain,window:'current_snapshot',cohorts:[{cohort:'cohort_a',population,metrics}]};
}
async function readSource(tx:Tx,ctx:SessionContext,selected:DomainAnalysisOptions):Promise<NativeSource>{
 switch(selected.domain){
  case 'attendance':return attendanceAnalysisSourceTx(tx,ctx,selected.companyIds,selected.month!);
  case 'leave':return leaveAnalysisSourceTx(tx,ctx,selected.companyIds);
  case 'claims':return claimsAnalysisSourceTx(tx,ctx,selected.companyIds);
  case 'performance':return performanceAnalysisSourceTx(tx,ctx,selected.companyIds,selected.cycleId);
  case 'rewards':return rewardsAnalysisSourceTx(tx,ctx,selected.companyIds,selected.rewardUnitId);
  case 'organisation':return organisationAnalysisSourceTx(tx,ctx,selected.companyIds);
 }
}
/** Native-backed report explanation. Current snapshots never pretend to be historic trend comparisons.
 * Source selection, exact membership and conditions are fingerprinted locally at every admission replay. */
export async function generateDomainAnalysis(supplied:SessionContext,options:DomainAnalysisOptions):Promise<string>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))},selected=selection(options);
 const configuration=await withTenant(ctx,async tx=>resolveActiveAiConfig(tx,await authorizeSourceTx(tx,ctx,selected),'report_insight'));
 if(!configuration)return unavailable();let originalFingerprint:string|undefined;
 return generatePrivateAiTaskAnalysis(configuration,'aggregate_snapshot_analysis_v1',async(tx,current)=>{
  const fresh=await authorizeSourceTx(tx,current,selected),source=await readSource(tx,fresh,selected);
  // Canonicalize row order without discarding multiplicity/condition changes or selecting caller-provided bands.
  const canonical=[...source.rows].map(row=>[row.personId,...definitions[selected.domain].metrics.map(metric=>row.conditions[metric])]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const fingerprint=createHash('sha256').update(JSON.stringify([selected,source.selection,canonical])).digest('hex');
  if(originalFingerprint!==undefined&&originalFingerprint!==fingerprint)return unavailable();originalFingerprint=fingerprint;
  return domainAnalysisProjection(selected.domain,source);
 });
}
