/** Human-only minimal additional-run selectors; not eligibility/pay calculation or model context. */
import {and,eq,isNull,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {withTenant} from '../../db/client';
import {company,department,payPeriod} from '../../db/schema';
import {assertReviewedMultiCycleRunActorTx} from './reviewed-multi-cycle-run-source';
import {lockAccessConfigurationTx} from '../access-configuration-lock';
import {lockLeaveDependencyConfigurationTx} from '../leave-dependency-lock';
import {lockPayrollPeriodsTx} from '../../packs/payroll/service';
import {periodFiledTx} from '../statutory-filed';
import {assertReviewedPayrollScopeCompanyTx} from '../../packs/payroll/service';
import {reviewedPayrollRunEmployeeChoicesTx} from '../read';
import {reviewedAdditionalPayrollCycleChoicesTx} from '../../packs/payroll/service';
import {assertWorkforceCompanyTx} from '../workforce-access';
import {visibleLabelIdsCondition} from '../system-labels';
import {MultiCycleRunActionChoices,MultiCycleRunCatalogue,MultiCycleRunCatalogueSelection,MultiCycleRunScopeSelection,MultiCycleRunScopeResult,MULTI_CYCLE_RUN_RESPONSE_BYTES} from '../../lib/assistant-actions/multi-cycle-run-browser-contract';
const capture=(ctx:SessionContext)=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
async function interval(tx:Tx,ctx:SessionContext){await lockAccessConfigurationTx(tx,ctx.tenantId);const fresh=await assertReviewedMultiCycleRunActorTx(tx,ctx);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);return fresh;}
async function selected(tx:Tx,ctx:SessionContext,p:{companyId:string;payPeriod:string}){const fresh=await interval(tx,ctx);await assertReviewedPayrollScopeCompanyTx(tx,fresh,p.companyId);await lockPayrollPeriodsTx(tx,fresh,[p],true);if((await periodFiledTx(tx,{companyId:p.companyId,periodKey:p.payPeriod})).filed)throw Error();const [period]=await tx.select({status:payPeriod.status}).from(payPeriod).where(and(eq(payPeriod.companyId,p.companyId),eq(payPeriod.period,p.payPeriod))).limit(1);if(period?.status==='closed')throw Error();return fresh;}
function bounded<T>(value:T):T{if(Buffer.byteLength(JSON.stringify(value))>MULTI_CYCLE_RUN_RESPONSE_BYTES)throw Error();return value;}
export async function readMultiCycleRunModuleActionChoices(supplied:SessionContext){const ctx=capture(supplied);try{return await withTenant(ctx,async tx=>{await interval(tx,ctx);const rows=await tx.select({companyId:company.id,name:company.legalName}).from(company).where(and(eq(company.tenantId,ctx.tenantId),isNull(company.archivedAt),sql`app.can_admin_payroll_for(${company.id}) and app.is_admin_for(${company.id})`)).orderBy(company.legalName,company.id).limit(21);return bounded(MultiCycleRunActionChoices.parse({kind:'choices',companies:rows.slice(0,20),truncated:rows.length>20}));});}catch{return MultiCycleRunActionChoices.parse({kind:'unavailable'});}}
export async function readMultiCycleRunCatalogue(supplied:SessionContext,value:unknown){const ctx=capture(supplied),p=MultiCycleRunCatalogueSelection.parse(structuredClone(value));return withTenant(ctx,async tx=>{const fresh=await selected(tx,ctx,p);return bounded(MultiCycleRunCatalogue.parse({kind:'catalogue',selection:p,...await reviewedAdditionalPayrollCycleChoicesTx(tx,fresh,p.companyId)}));});}
export async function searchMultiCycleRunScope(supplied:SessionContext,value:unknown){const ctx=capture(supplied),p=MultiCycleRunScopeSelection.parse(structuredClone(value));return withTenant(ctx,async tx=>{const fresh=await selected(tx,ctx,p);if(p.kind==='employees')return bounded(MultiCycleRunScopeResult.parse({kind:'employee_choices',selection:p,...await reviewedPayrollRunEmployeeChoicesTx(tx,fresh,p)}));await assertWorkforceCompanyTx(tx,fresh,p.companyId,'view');const q='%'+p.query.replace(/[\\%_]/g,c=>'\\'+c)+'%',name=sql<string>`coalesce(nullif(trim(${department.label}),''),nullif(trim(${department.description}),''),${department.name})`,rows=await tx.select({departmentId:department.id,name}).from(department).where(and(isNull(department.archivedAt),visibleLabelIdsCondition(department,'department',[p.companyId]),sql`${name} ilike ${q} escape ${'\\'}`)).orderBy(name,department.id).limit(21);return bounded(MultiCycleRunScopeResult.parse({kind:'department_choices',selection:p,departments:rows.slice(0,20),truncated:rows.length>20}));});}
