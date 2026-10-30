/** Native paid BASIC comparison → closed aggregate analysis. This is a source adapter only, not a
 * new payroll calculator, permission owner, privacy approval, UI rollout or provider fallback. */
import {createHash} from 'node:crypto';
import {types as nodeTypes} from 'node:util';
import {and,eq,inArray} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {employment,type CustomReportSpec} from '../db/schema';
import {executePayrollComparisonTx} from './report-payroll-comparison';
import {resolveActiveAiConfig} from './ai-config';
import {generatePrivateAiAnalysis} from './ai-governance';
import {AiGatewayError} from '../lib/ai/types';
import {PAYROLL_COMPARISON_DATASET,payrollAmountMinor} from '../lib/payroll-period-comparison';
import {PROVIDER_ANALYSIS_LIMITS} from '../lib/ai/provider-analysis-policy';
import {analysisPercentageBand,analysisNativeRatioBand} from '../lib/ai/provider-analysis-bands';
const unavailable=():never=>{throw new AiGatewayError('The private payroll comparison source could not be confirmed.');};
/** Retain ordinary JSON data only, without executing accessors or keeping caller-owned references. */
function capture<T>(input:T):T{
 let nodes=0;
 const copy=(value:unknown,depth:number):unknown=>{
  if(++nodes>20000||depth>20)return unavailable();
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number')return Number.isFinite(value)?value:unavailable();
  if(!value||typeof value!=='object'||nodeTypes.isProxy(value))return unavailable();
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  if(Array.isArray(value)){
   if(Object.getPrototypeOf(value)!==Array.prototype||keys.length!==value.length+1)return unavailable();
   return Object.freeze(Array.from({length:value.length},(_,index)=>{const entry=descriptors[String(index)];if(!entry||!('value'in entry))return unavailable();return copy(entry.value,depth+1);}));
  }
  if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))return unavailable();
  const output=Object.create(null) as Record<string,unknown>;
  for(const key of keys){const entry=descriptors[key as string];if(typeof key!=='string'||!entry?.enumerable||!('value'in entry))return unavailable();output[key]=copy(entry.value,depth+1);}
  return Object.freeze(output);
 };
 const result=copy(input,0);if(Buffer.byteLength(JSON.stringify(result),'utf8')>262144)return unavailable();return result as T;
}

/** Complete export authority is intentionally stricter than the paginated report view. Every source
 * replay delegates report, compensation, module and company permissions to the native export owner.
 * Only display filters are normalized; selected companies/departments/run type remain unchanged.
 * Counts below are DISTINCT PERSONS resolved locally from the authorized employment IDs. Population
 * is the union across periods; support is the conservative minimum of the two period person counts.
 * Employment counts are checked against native headcounts, never substituted for person support.
 * Native headcount has no native percentage/band, so it is deliberately not emitted as a metric.
 */
export async function generatePrivatePayrollComparisonAnalysis(ctx:SessionContext,spec:CustomReportSpec,scope:readonly string[],raw:Record<string,unknown>):Promise<string>{
 const capturedSpec=capture(spec),capturedScope=capture(scope),requested=capture(raw);
 if(capturedSpec.datasetId!==PAYROLL_COMPARISON_DATASET||!Array.isArray(capturedScope)||!capturedScope.length||capturedScope.length>100||capturedScope.some(id=>typeof id!=='string'))return unavailable();
 const full=Object.freeze({...requested,onlyVariances:false,minVariance:'0',reason:'',page:1,pageSize:200});
 const configuration=await withTenant(ctx,tx=>resolveActiveAiConfig(tx,ctx,'payroll_explanation'));
 if(!configuration)return unavailable();
 let originalFingerprint:string|undefined;
 return generatePrivateAiAnalysis(configuration,async(tx:Tx,current:SessionContext)=>{
  const execution=await executePayrollComparisonTx(tx,current,capturedSpec,capturedScope,full,'export');
  const{result,filters,definition}=execution,summary=result.summary;
  if(definition.payItemCode!=='BASIC'||execution.contextUnavailable||!result.available||result.provisional||result.issues.length||!summary||
    filters.onlyVariances||filters.reason!==null||filters.minVariance!=='0.00'||result.rows.length!==result.comparisonRows||result.rows.length!==result.displayedRows||!result.rows.length)return unavailable();
  if(!execution.companyIds.length||execution.companyIds.some(id=>!capturedScope.includes(id))||summary.totals.length!==1)return unavailable();
  const total=summary.totals[0];if(typeof total.currency!=='string'||! /^[A-Z]{3}$/.test(total.currency)||total.companyId!==null||result.rows.some(row=>row.currency!==total.currency||!execution.companyIds.includes(row.companyId)))return unavailable();
  let changeBand:ReturnType<typeof analysisPercentageBand>;
  try{
   // Canonical parsing only establishes sign/baseline validity. The native owner remains the sole
   // calculator of amounts, exact variance and variancePct. The shared classifier uses the native exact variance/baseline ratio, so a nonzero change rounded to 0.00% is never called unchanged.
   const baseline=payrollAmountMinor(total.previous);
   if(baseline<=BigInt('0')||payrollAmountMinor(total.current)<BigInt('0')||typeof total.variancePct!=='string'||typeof total.variance!=='string')return unavailable();
   analysisPercentageBand(total.variancePct); // Validate native reported percentage; never use its rounding for the band.
   changeBand=analysisNativeRatioBand(payrollAmountMinor(total.variance),baseline);
  }catch{return unavailable();}
  const employmentIds=[...new Set(result.rows.map(row=>row.employmentId))];
  const identities=await tx.select({employmentId:employment.id,personId:employment.personId}).from(employment)
   .where(and(eq(employment.tenantId,current.tenantId),inArray(employment.id,employmentIds)));
  const byEmployment=new Map<string,string>();
  for(const identity of identities){if(!employmentIds.includes(identity.employmentId)||byEmployment.has(identity.employmentId)||typeof identity.personId!=='string'||!identity.personId)return unavailable();byEmployment.set(identity.employmentId,identity.personId);}
  if(byEmployment.size!==employmentIds.length)return unavailable();
  const previousEmployments=new Set<string>(),currentEmployments=new Set<string>(),previousPeople=new Set<string>(),currentPeople=new Set<string>();
  for(const row of result.rows){
   if(typeof row.previousPresent!=='boolean'||typeof row.currentPresent!=='boolean'||!row.previousPresent&&!row.currentPresent)return unavailable();
   const personId=byEmployment.get(row.employmentId)!;
   if(row.previousPresent){previousEmployments.add(row.employmentId);previousPeople.add(personId);}
   if(row.currentPresent){currentEmployments.add(row.employmentId);currentPeople.add(personId);}
  }
  if(summary.previousHeadcount!==previousEmployments.size||summary.currentHeadcount!==currentEmployments.size)return unavailable();
  const population=new Set([...previousPeople,...currentPeople]).size,support=Math.min(previousPeople.size,currentPeople.size);
  if(population<PROVIDER_ANALYSIS_LIMITS.minimumPopulation||population>PROVIDER_ANALYSIS_LIMITS.maximumPopulation||support<PROVIDER_ANALYSIS_LIMITS.minimumPopulation)return unavailable();
  // Detect native changes even when both versions fall in the same coarse band. Only this ephemeral
  // hash is retained locally; no source row, ID, exact amount or hash enters the aggregate contract.
  const fingerprint=createHash('sha256').update(JSON.stringify([execution,[...byEmployment].sort(([left],[right])=>left.localeCompare(right))])).digest('hex');
  if(originalFingerprint!==undefined&&originalFingerprint!==fingerprint)return unavailable();originalFingerprint=fingerprint;
  return Object.freeze({version:1,domain:'payroll',window:'calendar_month',cohorts:Object.freeze([Object.freeze({cohort:'cohort_a',population,metrics:Object.freeze([
   Object.freeze({metric:'base_pay_cost',support,changeBand,drivers:Object.freeze([]),slices:Object.freeze([])}),
  ])})])});
 });
}
