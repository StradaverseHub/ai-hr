/** Settings change through their canonical owner; retention and posting outcomes come from actual signed commands. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {owner,migrateTestDb,resetDb,closeAll,createAppUser} from './harness';
import {resignationJourneyFixture} from './helpers/resignation-journey-fixture';
import {commandResignationJourney,submitResignationJourney,v9Configuration,v9SaveConfig} from '../packs/lifecycle/service';
import {listPersonnelPostings,personnelPosting} from '../packs/personnel-postings/service';
import type {ResignationCaseView} from '../lib/resignation-journey';
import type {Template} from '../lib/lifecycle-v9-model';
beforeAll(migrateTestDb);beforeEach(resetDb);afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);

// Two real signing chains and canonical shared-group writes need headroom beyond the fixture family's 90 s budget.
it('reassigns pending proposals to a populated group, preserves their old approvers for empty/deleted settings and blocks new proposals',async()=>{
 const f=await resignationJourneyFixture({compensation:{basicSalary:5000,currency:'MYR'}}),templateId=randomUUID(),groupB=randomUUID(),groupC=randomUUID(),approverB=await createAppUser(f.base.tenantId,f.fyi.personId,'hr_admin'),ctxB={...f.admin,userId:approverB,personId:f.fyi.personId};
 const config=structuredClone((await v9Configuration(f.admin)).config!);config.offboarding={postingApproverGroupId:f.groupId,reofferMonths:null};
 const template:Template={id:templateId,name:'Posting assignment retention terms',module:'off',type:'Letter',rules:{caseType:['Resignation']},hrStep:'none',employeeAck:true,retired:false,currentVersion:1,versions:[{version:1,state:'published',at:new Date().toISOString(),by:'Fixture configuration owner',fields:[],blocks:[{id:'terms',type:'text',text:'Dear {employee.name}. Revised salary {retention.salary}.',section:''},{id:'hr-signature',type:'signature',role:'step:hr',text:'',section:''},{id:'employee-signature',type:'signature',role:'step:employee',text:'',section:''}],routing:[{id:'hr',order:1,action:'sign',who:{kind:'people',userIds:[f.managerUserId]},owner:true},{id:'employee',order:2,action:'sign',who:{kind:'employee'},owner:false}]}]};
 config.templates.push(template);await v9SaveConfig(f.admin,config.revision,config);
 await f.workflow('retention',[{id:'generate',type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:templateId}}]);
 await f.workflow('offerAccepted',[{id:'salary-posting',type:'createPosting',conditions:[],to:[],cc:[],params:{eventType:'Increment',dateFrom:'offerEff',fields:['salary']}}]);
 const prepareReply=async(value:ResignationCaseView,salary:string)=>{
  value=await commandResignationJourney(f.admin,{caseId:value.id,revision:value.revision,command:{type:'offer',offer:{position:'Agreed retention position',jobGrade:'',basicSalary:salary,effectiveDate:f.lastWorkingDay,justification:'Actual signed posting assignment fixture.'}}});
  value=await commandResignationJourney(f.admin,{caseId:value.id,revision:value.revision,command:{type:'letterAction',documentId:value.letters[0].id,documentRevision:value.letters[0].revision,action:'sign',signature:'Journey manager',consent:true}});
  return commandResignationJourney(f.staff,{caseId:value.id,revision:value.revision,command:{type:'openLetter',documentId:value.letters[0].id,documentRevision:value.letters[0].revision}});
 };
 const sign=(value:ResignationCaseView)=>commandResignationJourney(f.staff,{caseId:value.id,revision:value.revision,command:{type:'letterAction',documentId:value.letters[0].id,documentRevision:value.letters[0].revision,action:'sign',signature:'Journey employee',consent:true}});
 const first=await sign(await prepareReply(f.journey,'5500.00'));expect(first.stage).toBe('retained');const rows=(await listPersonnelPostings(f.admin,{source:'offboarding',status:'pending'})).rows;expect(rows).toHaveLength(1);const postingId=rows[0].id;
 const snapshot=async()=>{const[row]=await owner.db.execute<{value:Record<string,unknown>}>(sql`select to_jsonb(p) as value from personnel_posting p where p.tenant_id=${f.base.tenantId}::uuid and p.id=${postingId}::uuid`);return row.value;},before=await snapshot();
 expect(await personnelPosting(f.admin,postingId)).toMatchObject({approverGroupId:f.groupId,sourceRef:first.id,status:'pending',canApprove:true});
 const change=structuredClone((await v9Configuration(f.admin)).config!);change.groups.push({id:groupB,name:'New actual posting approvers',members:[approverB],limit:100},{id:groupC,name:'Empty future posting approvers',members:[],limit:100});change.offboarding={postingApproverGroupId:groupB,reofferMonths:null};await v9SaveConfig(f.admin,change.revision,change);
 const moved=await snapshot();expect(moved).toEqual({...before,approver_group_id:groupB,revision:Number(before.revision)+1});expect(await personnelPosting(ctxB,postingId)).toMatchObject({approverGroupId:groupB,canApprove:true});expect(await personnelPosting(f.admin,postingId)).toMatchObject({canApprove:false});
 const empty=structuredClone((await v9Configuration(f.admin)).config!);empty.offboarding={postingApproverGroupId:groupC,reofferMonths:null};await v9SaveConfig(f.admin,empty.revision,empty);expect(await snapshot()).toEqual(moved);expect(await personnelPosting(ctxB,postingId)).toMatchObject({approverGroupId:groupB,canApprove:true});
 const next=await submitResignationJourney(f.staff,{employmentId:f.employee.employmentId,lastWorkingDay:f.lastWorkingDay,reason:'A second case tests new proposal settings.'}),reply=await prepareReply(next,'5700.00');
 const caseSnapshot=async()=>{const[row]=await owner.db.execute<{value:string}>(sql`select to_jsonb(j)::text as value from resignation_journey j where j.tenant_id=${f.base.tenantId}::uuid and j.id=${reply.id}::uuid`);return row.value;},pendingReply=await caseSnapshot();
 const repairError={name:'ResignationJourneyError',code:'invalid',message:'Ask People Ops to choose a populated approver group in Onboarding & offboarding settings → Offboarding → Personnel postings, then retry.'};
 const selected=(await v9Configuration(f.admin)).config!;expect(selected.offboarding?.postingApproverGroupId).toBe(groupC);expect(selected.groups.find(group=>group.id===groupC)?.members).toEqual([]);
 // The native proposal refuses an empty current group; the thrown effect rolls the whole final-sign transaction back.
 await expect(sign(reply)).rejects.toMatchObject(repairError);expect(await caseSnapshot()).toBe(pendingReply);expect(await snapshot()).toEqual(moved);
 expect((await listPersonnelPostings(f.admin,{source:'offboarding',status:'pending'})).rows.map(row=>row.id)).toEqual([postingId]);
 const configSnapshot=async()=>{const[row]=await owner.db.execute<{v9:string;groups:string}>(sql`select to_jsonb(v)::text as v9,to_jsonb(g)::text as groups from lc_v9_config v join lc_onboarding_config g on g.tenant_id=v.tenant_id where v.tenant_id=${f.base.tenantId}::uuid`);return row;},saved=await configSnapshot();
 const unknown=structuredClone((await v9Configuration(f.admin)).config!);unknown.offboarding={postingApproverGroupId:randomUUID(),reofferMonths:null};await expect(v9SaveConfig(f.admin,unknown.revision,unknown)).rejects.toThrow(/existing assignment group/);expect(await configSnapshot()).toEqual(saved);
 const removed=structuredClone((await v9Configuration(f.admin)).config!);removed.groups=removed.groups.filter(group=>group.id!==groupC);await expect(v9SaveConfig(f.admin,removed.revision,removed)).rejects.toThrow(/replacement flow/);expect(await configSnapshot()).toEqual(saved);expect(await snapshot()).toEqual(moved);
 // Historical absent-group source only: current canonical saves deliberately forbid direct shared-group deletion.
 // No journey, offer, signature, posting or outcome is forged by this owner fixture setup.
 for(const table of ['lc_onboarding_config','lc_v9_config'])await owner.db.execute(sql`update ${sql.identifier(table)} set data=jsonb_set(data,'{groups}',(select coalesce(jsonb_agg(g),'[]'::jsonb) from jsonb_array_elements(data->'groups') g where g->>'id'<>${groupC})) where tenant_id=${f.base.tenantId}::uuid`);
 await expect(sign(reply)).rejects.toMatchObject(repairError);expect(await caseSnapshot()).toBe(pendingReply);expect(await snapshot()).toEqual(moved);expect(await personnelPosting(ctxB,postingId)).toMatchObject({approverGroupId:groupB,canApprove:true});
 expect((await listPersonnelPostings(f.admin,{source:'offboarding',status:'pending'})).rows.map(row=>row.id)).toEqual([postingId]);
 // Positive control: only repair the selected group, then retry the identical saved case/letter signature.
 const repair=structuredClone((await v9Configuration(f.admin)).config!);expect(repair.offboarding?.postingApproverGroupId).toBe(groupC);expect(repair.groups.some(group=>group.id===groupC)).toBe(false);repair.offboarding={...repair.offboarding,postingApproverGroupId:groupB};await v9SaveConfig(f.admin,repair.revision,repair);
 expect(await caseSnapshot()).toBe(pendingReply);const accepted=await sign(reply);expect(accepted.stage).toBe('retained');
 const completed=(await listPersonnelPostings(f.admin,{source:'offboarding',status:'pending'})).rows;expect(completed).toHaveLength(2);expect(completed.filter(row=>row.sourceRef===reply.id)).toEqual([expect.objectContaining({approverGroupId:groupB,eventType:'increment',status:'pending',proposed:{effectiveDate:f.lastWorkingDay,basicSalary:'5700.00'}})]);expect(await snapshot()).toEqual(moved);
},120000);
