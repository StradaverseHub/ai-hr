import {sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,afterEach,vi,it,expect} from 'vitest';
import {withTenant} from '../db/client';
import {owner,migrateTestDb,resetDb,closeAll} from './harness';
import {resignationJourneyFixture} from './helpers/resignation-journey-fixture';
import {commandResignationJourney} from '../packs/lifecycle/service';
import {v9CaseDetail,v9Command} from '../packs/lifecycle/v9/service';
import {raiseResignationClearancePostingTx} from '../core/resignation-clearance';
import {approvePersonnelPosting,listPersonnelPostings,personnelPosting} from '../core/personnel-posting';
import type {PersonnelPostingValues} from '../lib/personnel-posting';
import {defaultSettlementPolicy} from '../lib/lifecycle-v9-calculator';
beforeAll(migrateTestDb);beforeEach(resetDb);afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);

it.each(['Retirement','Contract end'] as const)('carries configured %s from the actual cleared case into its posting without changing the resignation narrative',async exitReason=>{
 const f=await resignationJourneyFixture({compensation:{basicSalary:5000,currency:'SGD'}});
 // Genuine source figures: a posted zero leave adjustment supplies a known zero balance, not a guessed missing one.
 await owner.db.execute(sql`insert into leave_ledger(tenant_id,employment_id,leave_type_id,entry_type,days,effective_on,reason) values(${f.base.tenantId}::uuid,${f.employee.employmentId}::uuid,${f.base.annualLeaveTypeId}::uuid,'adjustment',0,'2026-01-01','Fictional opening zero balance')`);
 f.config.checklists=[];f.config.workflows=[];f.config.offboarding={postingApproverGroupId:f.groupId,reofferMonths:12};
 f.config.settlementPolicy={...defaultSettlementPolicy(),leaveTypeIds:[f.base.annualLeaveTypeId]};
 await owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(f.config)}::jsonb where tenant_id=${f.base.tenantId}::uuid`);
 await f.workflow('accepted',[{id:'clearance',type:'startOffboarding',conditions:[],to:[],cc:[],params:{exitReason}}]);
 const accepted=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'accept',lastWorkingDay:f.lastWorkingDay,replacementNeeded:false}});
 expect(accepted.blocked).toEqual([]);expect(accepted.offboardingCaseId).toBeTruthy();
 const caseId=accepted.offboardingCaseId!;let detail=await v9CaseDetail(f.admin,caseId);
 expect(detail.case.facts.caseType).toBe(exitReason);
 await v9Command(f.admin,caseId,detail.case.revision,{type:'submit'});detail=await v9CaseDetail(f.admin,caseId);
 expect(detail.calculation).toMatchObject({ready:true,lastDay:f.lastWorkingDay,currency:'SGD',remainingLeave:0});
 expect((await listPersonnelPostings(f.admin,{source:'offboarding',status:'all'})).rows).toEqual([]);
 // Even HR cannot read the raw journey in this fresh transaction: the clearance owner must obtain its narrow custody proof.
 expect(await withTenant(f.admin,tx=>tx.execute(sql`select id from resignation_journey where id=${accepted.id}::uuid`))).toEqual([]);
 // A managed clearance with a missing posting owner must roll back the case and payroll handover, not silently finish.
 await owner.db.execute(sql`update lc_v9_config set data=jsonb_set(data,'{offboarding,postingApproverGroupId}','null'::jsonb) where tenant_id=${f.base.tenantId}::uuid`);
 await expect(v9Command(f.admin,caseId,detail.case.revision,{type:'clear',sourceRevision:detail.calculation!.sourceRevision,reason:'Attempt before assigning a posting owner.'})).rejects.toThrow(/Choose who approves Offboarding Personnel postings/);
 const unchanged=await v9CaseDetail(f.admin,caseId);expect(unchanged.case).toMatchObject({state:'submitted',revision:detail.case.revision,finalFigures:null});
 expect(await owner.db.execute(sql`select id from lc_v9_payroll_handover where tenant_id=${f.base.tenantId}::uuid and case_id=${caseId}::uuid`)).toEqual([]);
 expect((await listPersonnelPostings(f.admin,{source:'offboarding',status:'all'})).rows).toEqual([]);
 await owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(f.config)}::jsonb where tenant_id=${f.base.tenantId}::uuid`);
 await v9Command(f.admin,caseId,detail.case.revision,{type:'clear',sourceRevision:detail.calculation!.sourceRevision,reason:'Completed the configured exit clearance.'});
 detail=await v9CaseDetail(f.admin,caseId);expect(detail.case.state).toBe('cleared');
 const postings=(await listPersonnelPostings(f.admin,{source:'offboarding',status:'all'})).rows;expect(postings).toHaveLength(1);
 const posting=await personnelPosting(f.admin,postings[0].id);expect(posting).toMatchObject({source:'offboarding',sourceRef:accepted.id,eventType:'termination',status:'pending',current:{exitReason,effectiveDate:f.lastWorkingDay,resignationDate:accepted.submittedOn}});
 const repeated=await withTenant(f.admin,tx=>raiseResignationClearancePostingTx(tx,f.admin,{caseId,employmentId:f.employee.employmentId,lastWorkingDay:f.lastWorkingDay,exitReason:'Termination'}));
 expect(repeated?.id).toBe(posting!.id); // The caller cannot choose a reason, even on an idempotent replay.
 const forged={...posting!.current,exitReason:'Resignation'};
 const nativeCreate=(proposed:PersonnelPostingValues,key:string)=>withTenant(f.admin,tx=>tx.execute(sql`select app.personnel_posting_create('offboarding',${accepted.id}::uuid,${f.employee.employmentId}::uuid,'termination',${JSON.stringify(proposed)}::jsonb,${f.groupId},${key})`));
 await expect(nativeCreate(posting!.current,'spoofed-clearance-key')).rejects.toMatchObject({cause:{code:'22023',message:'Termination posting requires the canonical clearance idempotency key'}});
 await expect(nativeCreate(forged,'clearance:'+caseId)).rejects.toMatchObject({cause:{code:'22023',message:'Posting retry changed its frozen source values'}});
 expect((await listPersonnelPostings(f.admin,{source:'offboarding',status:'all'})).rows.map(row=>row.id)).toEqual([posting!.id]);
 await expect(withTenant(f.admin,tx=>tx.execute(sql`select app.personnel_posting_approve(${posting!.id}::uuid,${posting!.revision},${JSON.stringify(forged)}::jsonb)`))).rejects.toMatchObject({cause:{code:'22023',message:'Termination must use the completed Offboarding case exit reason and source facts'}});
 expect(await personnelPosting(f.admin,posting!.id)).toMatchObject({status:'pending',revision:posting!.revision,applied:null,movementId:null});
 await approvePersonnelPosting(f.admin,{id:posting!.id,revision:posting!.revision});
 expect(await personnelPosting(f.admin,posting!.id)).toMatchObject({status:'approved',applied:{exitReason},movementId:expect.any(String)});
 const [employment]=await owner.db.execute<{type:string;reason:string}>(sql`select termination_type as type,termination_reason as reason from employment where id=${f.employee.employmentId}::uuid`);
 expect(employment).toEqual({type:'voluntary',reason:'A real authorized fixture resignation.'});
},90000);
