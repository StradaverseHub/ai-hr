/** Execution adapter under the existing saved-report owner. It consumes Payroll, Movement and dated
 * Organisation reads; there is no second pay calculator or saved-definition store. */
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { company, department, employment, jobGrade, person, costCenter, payrollBatch, type CustomReportSpec } from '../db/schema';
import { payrollComparisonSourcesTx, listPayComponents } from '../packs/payroll/service';
import { assignmentVersionsForReportTx } from './org';
import { provenCompanyDatesTx, dayBefore } from './employment-company';
import { movementReportFactsTx } from './movement';
import { payrollComparisonAccessTx } from './report-payroll-access';
import { visibleLabelIdsCondition } from './system-labels';
import { withTenant } from '../db/client';
import { payPeriodBounds } from './payslip-segment';
import { todayInKualaLumpur } from '../lib/hr-date';
import { isCalendarDate } from '../lib/calendar-date';
import {
  DEFAULT_PAYROLL_COMPARISON, PAYROLL_COMPARISON_DATASET, payrollComparisonFilters,
  validatePayrollComparisonDefinition, type PayrollComparisonMovement,
} from '../lib/payroll-period-comparison';
import {payrollComparisonDatedSubjects} from '../lib/payroll-comparison-source';
import { comparePayrollResults, type ComparisonIdentity, type ComparisonResult } from '../lib/payroll-comparison-result';
import { MasterReportAccessError } from './employee-master-access';
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
export const payrollComparisonSpec=(definition=DEFAULT_PAYROLL_COMPARISON):CustomReportSpec=>({
  datasetId:PAYROLL_COMPARISON_DATASET,payrollComparison:definition,
  columns:[...definition.columns,'previous','current','variance','reason','currency'],
});
export async function payrollComparisonOptions(ctx:SessionContext,scope:readonly string[]){
  const spec=payrollComparisonSpec();
  const choices=await withTenant(ctx,async tx=>{
    const ids=await payrollComparisonAccessTx(tx,ctx,spec,'view',scope);
    const companies=await tx.select({id:company.id,name:company.legalName}).from(company).where(inArray(company.id,ids)).orderBy(asc(company.legalName),asc(company.id));
    const departments=await tx.select({id:department.id,name:department.name}).from(department)
      .where(visibleLabelIdsCondition(department,'department',ids)).orderBy(asc(department.name),asc(department.id));
    const periods=await tx.selectDistinct({period:payrollBatch.payPeriod}).from(payrollBatch)
      .where(inArray(payrollBatch.companyId,ids)).orderBy(desc(payrollBatch.payPeriod)).limit(1200);
    return {companies,departments,periods:periods.map(row=>row.period)};
  },{readOnlySnapshot:true});
  const items=await listPayComponents(ctx,{readyOnly:true});
  return {...choices,payItems:[{code:'BASIC',name:'Basic Salary actually paid'},...items.filter(item=>item.code!=='BASIC').map(item=>({code:item.code,name:item.name}))]};
}
export type PayrollComparisonExecution={filters:ReturnType<typeof payrollComparisonFilters>;definition:ReturnType<typeof validatePayrollComparisonDefinition>;
  result:ComparisonResult;companyIds:string[];sourceRevisions:{id:string;version:number;runId:string}[];contextUnavailable:boolean};

export async function executePayrollComparisonTx(tx:Tx,ctx:SessionContext,spec:CustomReportSpec,scope:readonly string[],raw:Record<string,unknown>,verb:'view'|'export'):Promise<PayrollComparisonExecution>{
  const definition=validatePayrollComparisonDefinition(spec.payrollComparison);
  let filters=payrollComparisonFilters(raw,definition);
  const scopeIds=filters.companyId?[filters.companyId]:[...scope];
  if(scopeIds.some(id=>!scope.includes(id)))throw new MasterReportAccessError();
  const ids=await payrollComparisonAccessTx(tx,ctx,spec,verb,scopeIds);
  if(!filters.currentPeriod){
    const [latest]=await tx.select({period:payrollBatch.payPeriod}).from(payrollBatch)
      .where(and(inArray(payrollBatch.companyId,ids),inArray(payrollBatch.status,['processed','closed']),isNull(payrollBatch.needsRecalcAt),
        filters.runType==='regular'?eq(payrollBatch.runType,'regular'):undefined))
      .orderBy(desc(payrollBatch.payPeriod),desc(payrollBatch.runSeq),asc(payrollBatch.id)).limit(1);
    filters=payrollComparisonFilters({...raw,currentPeriod:latest?.period??todayInKualaLumpur().slice(0,7)},definition);
  }
  const previous=payPeriodBounds(filters.previousPeriod!),current=payPeriodBounds(filters.currentPeriod!);
  if(!previous||!current)throw new Error('Choose valid payroll periods.');
  const {runs,sources}=await payrollComparisonSourcesTx(tx,ctx,{companyIds:ids,previousPeriod:filters.previousPeriod!,currentPeriod:filters.currentPeriod!,runType:filters.runType,payItemCode:definition.payItemCode});
  const employmentIds=[...new Set(sources.map(source=>source.employmentId))];
  if(employmentIds.length>10000)throw new Error('This comparison exceeds 10000 employments. Narrow the company scope.');
  const identities:ComparisonIdentity[]=[];
  let contextUnavailable=false;
  if(employmentIds.length){
    const employees=await tx.select({id:employment.id,employeeCode:employment.employeeCode,employeeName:person.fullName,hiredOn:employment.hiredOn})
      .from(employment).innerJoin(person,eq(person.id,employment.personId)).where(inArray(employment.id,employmentIds)).orderBy(asc(employment.id));
    const people=new Map(employees.map(row=>[row.id,row]));
    const pairs=payrollComparisonDatedSubjects(sources,runs,filters.previousPeriod!,filters.currentPeriod!);
    const versions=await assignmentVersionsForReportTx(tx,employmentIds,previous.from,current.to);
    const movementFacts=await movementReportFactsTx(tx,ctx.tenantId,employmentIds,[...new Set(pairs.map(pair=>pair.date))]);
    const factsByEmployment=new Map(movementFacts.map(fact=>[fact.employmentId,fact]));
    const companyNames=new Map((await tx.select({id:company.id,name:company.legalName}).from(company).where(inArray(company.id,ids))).map(row=>[row.id,row.name]));
    const departmentNames=new Map((await tx.select({id:department.id,name:department.name}).from(department).where(visibleLabelIdsCondition(department,'department',ids))).map(row=>[row.id,row.name]));
    const centreNames=new Map((await tx.select({id:costCenter.id,name:costCenter.name}).from(costCenter).where(visibleLabelIdsCondition(costCenter,'cost_center',ids))).map(row=>[row.id,row.name]));
    const gradeIds=[...new Set(movementFacts.flatMap(fact=>fact.placements.flatMap(placement=>placement.gradeId?[placement.gradeId]:[])))];
    const gradeNames=new Map((gradeIds.length?await tx.select({id:jobGrade.id,name:jobGrade.name}).from(jobGrade).where(inArray(jobGrade.id,gradeIds)):[]).map(row=>[row.id,row.name]));
    const sourcesByEmployment=new Map<string,typeof sources>();
    for(const source of sources){
      const group=sourcesByEmployment.get(source.employmentId)??[];group.push(source);sourcesByEmployment.set(source.employmentId,group);
    }
    const dates=pairs.map(pair=>({employmentId:pair.employmentId,date:pair.date}));
    const proofs=await provenCompanyDatesTx(tx,dates);
    const versionsByEmployment=new Map<string,typeof versions>();
    for(const version of versions){const group=versionsByEmployment.get(version.employmentId)??[];group.push(version);versionsByEmployment.set(version.employmentId,group);}
    for(const pair of pairs){
      const employee=people.get(pair.employmentId),facts=factsByEmployment.get(pair.employmentId);
      if(!employee||!facts)throw new MasterReportAccessError();
      const date=pair.date;
      const proof=proofs.get(pair.employmentId+'|'+date);
      const placement=proof?.companyId===pair.companyId?(versionsByEmployment.get(pair.employmentId)??[]).find(version=>version.validFrom<=date&&(!version.validTo||version.validTo>date)):undefined;
      const grade=facts.placements.find(value=>value.date===date);
      if(!placement||!grade?.gradeKnown)contextUnavailable=true;
      const movements:PayrollComparisonMovement[]=[],verifiedTransferIds:string[]=[];
      let exitDate:string|null=null;
      for(const row of facts.rows){
        const termination=row.events.find(event=>event.eventType==='employment.terminated');
        if(termination){
          const payload=object(termination.payload),recorded=isCalendarDate(row.endDate??'')?row.endDate:payload.terminationDate;
          if(typeof recorded==='string'&&isCalendarDate(recorded)){
            movements.push({id:row.id,sequence:row.sequence,effectiveDate:recorded,kind:'exit',status:row.status,salaryChanged:false});
            if(row.status==='applied'&&recorded<=current.to&&(!exitDate||recorded>exitDate))exitDate=recorded;
          }
        }else if(['increment','promotion','demotion'].includes(row.behaviourKind)){
          movements.push({id:row.id,sequence:row.sequence,effectiveDate:row.effectiveDate,kind:row.behaviourKind as 'increment'|'promotion'|'demotion',status:row.status,salaryChanged:row.salaryChanged});
        }else if(row.behaviourKind==='entityTransfer'){
          const transfer=row.events.find(event=>event.eventType==='employment.company.transferred');
          const payload=object(transfer?.payload),from=object(payload.before).companyId,to=object(payload.after).companyId;
          const ownSources=sourcesByEmployment.get(pair.employmentId)??[];
          const before=typeof from==='string'&&ids.includes(from)&&ownSources.some(source=>source.companyId===from&&source.coverage.to===dayBefore(row.effectiveDate));
          const after=typeof to==='string'&&ids.includes(to)&&ownSources.some(source=>source.companyId===to&&source.coverage.from===row.effectiveDate);
          movements.push({id:row.id,sequence:row.sequence,effectiveDate:row.effectiveDate,kind:'transfer',status:row.status,salaryChanged:false});
          if(before&&after)verifiedTransferIds.push(row.id);
        }
      }
      identities.push({employmentId:pair.employmentId,companyId:pair.companyId,employeeCode:employee.employeeCode,
        employeeName:employee.employeeName,company:companyNames.get(pair.companyId)??'',hireDate:employee.hiredOn,exitDate,
        departmentId:placement?.departmentId??null,department:placement?departmentNames.get(placement.departmentId)??null:null,
        costCentre:placement?.costCenterId?centreNames.get(placement.costCenterId)??null:null,
        grade:placement&&grade?.gradeId?gradeNames.get(grade.gradeId)??null:null,movements,verifiedTransferIds});
    }
  }
  const result=comparePayrollResults({definition,filters,companyIds:ids,runs,sources,identities,
    previousFrom:previous.from,currentFrom:current.from,currentTo:current.to,paginate:verb!=='export'});
  return {definition,filters,result,companyIds:ids,sourceRevisions:sources.map(({id,version,runId})=>({id,version,runId})),contextUnavailable};
}
