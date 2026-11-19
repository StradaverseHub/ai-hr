import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {inquiryBalancePage} from '../../app/leave/employee-balances/inquiry-data';
import {employeeBalanceRows,type EmployeeBalanceRow} from '../../app/leave/employee-balances/rows';
import {leaveInquiryBalancePairsTx,leaveInquirySnapshot,readLeaveInquiryPicker,readLeaveInquiryPickerTx} from '../../core/leave-inquiry';
import {adminCompaniesTx,leaveInquiryPickerDisplayRowsTx,leaveInquiryPickerFacetsTx,listLeaveInquiryPickerIdentitiesTx} from '../../core/read';
import {withTenant,type SessionContext} from '../../db/client';
import type {EmployeeChoiceInput} from '../../lib/employee-choice';
import {sortInquiryEmployees} from '../../lib/leave-inquiry';
import {matchesLeaveInquiryPicker,normalizeLeaveInquiryPicker} from '../../lib/leave-inquiry-picker';
import {parseInquiryQuery} from '../../lib/leave-inquiry-query';
import {closeAll,migrateTestDb,owner} from '../harness';
import {restoreWorkforceCapabilityCatalogue} from './personnel-scale-fixture';
import {seedPersonnelSearchFixture} from './personnel-search-fixture';

beforeAll(migrateTestDb);
afterAll(async()=>{
  try{await restoreWorkforceCapabilityCatalogue();}
  finally{await closeAll();}
},120_000);

async function timed<T>(read:()=>T|Promise<T>){
  const start=performance.now();
  const result=await read();
  return {result,ms:Math.round(performance.now()-start)};
}

function measurePickerOwners(ctx:SessionContext,scope:string[],input:EmployeeChoiceInput) {
  const {filters,limit,offset}=normalizeLeaveInquiryPicker(input);
  return withTenant(ctx,async tx=>{
    const access=await timed(async()=>(await adminCompaniesTx(tx))
      .filter(company=>scope.includes(company.id)).map(company=>company.id));
    const candidates=await timed(()=>listLeaveInquiryPickerIdentitiesTx(ctx,tx,access.result,filters));
    const matching=await timed(()=>sortInquiryEmployees(
      candidates.result.filter(row=>matchesLeaveInquiryPicker(row,filters.query)),'en'));
    const identities=matching.result.slice(offset,offset+limit);
    const display=await timed(()=>leaveInquiryPickerDisplayRowsTx(ctx,tx,access.result,identities));
    const facets=await timed(()=>leaveInquiryPickerFacetsTx(ctx,tx,access.result));
    return {
      ids:identities.map(row=>row.employmentId),displayRows:display.result.length,
      total:matching.result.length,populationTotal:facets.result.populationTotal,
      costs:{scopeMs:access.ms,identitiesMs:candidates.ms,sortMs:matching.ms,
        displayMs:display.ms,facetsMs:facets.ms,candidateRows:candidates.result.length},
    };
  },{readOnlySnapshot:true});
}

it('measures the employee chooser and its owners at group and single-company scale',async()=>{
  const employments=10_000,companies=76;
  const fixture=await seedPersonnelSearchFixture({count:employments,companies,runs:4});
  const [person]=await owner.client<{code:string}[]>`
    select employee_code as code from employment
    where tenant_id=${fixture.base.tenantId}::uuid and voided_at is null and employee_code like 'FX-%'
    order by employee_code limit 1`;
  expect(person?.code).toBeTruthy();
  const cases=[
    {name:'group-all-open',ctx:fixture.admin,scope:fixture.companies,input:{limit:25}},
    {name:'group-all-selective',ctx:fixture.admin,scope:fixture.companies,input:{limit:25,query:person.code}},
    {name:'group-single-company-open',ctx:fixture.admin,scope:[fixture.base.companyId],input:{limit:25}},
    {name:'company-hr-open',ctx:fixture.manager,scope:fixture.companies,input:{limit:25}},
  ];
  const evidence=[];
  for(const {name,ctx,scope,input} of cases){
    const full=await timed(()=>readLeaveInquiryPicker(ctx,scope,input,'en'));
    const measured=await measurePickerOwners(ctx,scope,input);
    expect(full.result.rows.map(row=>row.employmentId),name).toEqual(measured.ids);
    expect(full.result.rows,name).toHaveLength(measured.displayRows);
    expect(full.result.total,name).toBe(measured.total);
    expect(full.result.populationTotal,name).toBe(measured.populationTotal);
    expect(full.result.rows.length,name).toBeGreaterThan(0);
    if(name==='group-all-selective')expect(full.result.rows.every(row=>row.employeeCode===person.code)).toBe(true);
    if(name==='group-all-open')expect(full.result.populationTotal).toBeGreaterThan(1_000);
    evidence.push({name,fullPickerMs:full.ms,matchedRows:measured.total,population:measured.populationTotal,...measured.costs});
  }
  const balanceEvidence=[];
  for(const {name,ctx,scope} of cases.filter(row=>row.name!=='group-all-selective')){
    const query=parseInquiryQuery({asOf:fixture.today},'balances');
    const frameStart=performance.now();
    const row=await leaveInquirySnapshot(ctx,scope,query,async(tx,selection)=>{
      const snapshotMs=Math.round(performance.now()-frameStart);
      const full=await timed(()=>inquiryBalancePage(ctx,selection,query,'en',query.pq,tx));
      const pairs=await timed(()=>leaveInquiryBalancePairsTx(tx,ctx,selection,query,'en'));
      const unbundled=await timed(async()=>{
        const requested=new Map<string,string[]>();
        for(const pair of pairs.result.rows){
          const ids=requested.get(pair.employee.employmentId)??[];
          ids.push(pair.leaveTypeId);
          requested.set(pair.employee.employmentId,ids);
        }
        const rowsByPair=new Map<string,EmployeeBalanceRow>();
        for(const [id,requestedTypeIds] of requested){
          for(const row of await employeeBalanceRows(ctx,id,query.asOf,'en',{},{requestedTypeIds,tx})){
            rowsByPair.set(id+'|'+row.leaveTypeId,row);
          }
        }
        return pairs.result.rows.map(({employee,leaveTypeId})=>({
          ...rowsByPair.get(employee.employmentId+'|'+leaveTypeId),employee,
        }));
      });
      expect(full.result.rows.length,name).toBeGreaterThan(0);
      expect(full.result.total,name).toBe(pairs.result.total);
      expect(full.result.rows,name).toEqual(unbundled.result);
      return {name,snapshotMs,scopeRows:selection.employees.length,balanceReadMs:full.ms,
        unbundledBalanceReadMs:pairs.ms+unbundled.ms,membershipMs:pairs.ms,
        visiblePairs:pairs.result.total,displayedRows:full.result.rows.length};
    });
    balanceEvidence.push(row);
  }
  const landingCases=[cases[0],cases[0],cases[2],cases[3]];
  const concurrentLandings=await Promise.all(landingCases.map(async({name,ctx,scope})=>{
    const query=parseInquiryQuery({asOf:fixture.today},'balances');
    const landing=await timed(()=>leaveInquirySnapshot(ctx,scope,query,async(tx,selection)=>{
      const picker=await readLeaveInquiryPickerTx(tx,ctx,selection.companyIds,{limit:25},'en');
      const balance=await inquiryBalancePage(ctx,selection,query,'en',query.pq,tx);
      return {people:picker.populationTotal,pickerRows:picker.rows.length,balanceRows:balance.rows.length,total:balance.total};
    }));
    const expected=balanceEvidence.find(row=>row.name===name);
    expect(landing.result.total,name).toBe(expected?.visiblePairs);
    expect(landing.result.balanceRows,name).toBe(expected?.displayedRows);
    expect(landing.result.pickerRows,name).toBe(25);
    return {name,landingDataMs:landing.ms,...landing.result};
  }));
  const report=JSON.stringify({kind:'LEAVE_INQUIRY_COMPONENT_ONLY',companies,employments,evidence,balanceEvidence,concurrentLandings});
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR){
    writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'leave-inquiry-picker-scale.json'),report);
  }
  console.info(report);
},360_000);
