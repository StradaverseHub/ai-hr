// Shared fixture for the Probation form approver tests (lanes H1/H2): a native Part 3 case whose pinned form version
// carries the given approval rows, taken through the real commands. The admin is the case's PBP and GBS and the
// fallback group. Fictional people only.
import {automationBusinessPartnerWorkspace,saveAutomationBusinessPartners,type BusinessPartnerRule} from '../../packs/automation/service';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {hireEmployee,setReportingLine} from '../../core/org';
import {createAppUser,owner,type Base} from '../harness';
import {newProbationPart} from '../../lib/probation-model';
import {todayInKualaLumpur} from '../../lib/hr-date';
import type {SessionContext} from '../../db/client';
import type {SigningRoute} from '../../lib/document-signing-model';
import type {ProbationApprovalRow} from '../../lib/probation-form';
import {probationCase,saveProbationDraft,actOnProbation,DEFAULT_PROBATION_CONFIG,DEFAULT_PROBATION_FORM,defaultProbationRoutes} from '../../packs/probation/service';

const assessment=Object.fromEntries(DEFAULT_PROBATION_FORM.criteria.map(c=>[c.id,{rating:4,evidence:'Observed fictional evidence for this criterion'}]));

export function probationFormCaseFixture(b:Base,start:SessionContext){
 let admin=start;
async function saveBusinessPartners(rules:BusinessPartnerRule[]){
 const current=await automationBusinessPartnerWorkspace(admin);
 if(!current)throw Error('The actual fixture administrator cannot configure Business Partner responsibilities.');
 await saveAutomationBusinessPartners(admin,{expectedRevision:current.revision,rules,reason:'Reviewed fictional Contract and Probation Business Partner responsibilities'});
}

async function person(name:string){
 const e=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@probation.example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
 const userId=await createAppUser(b.tenantId,e.personId,'employee');
 return{...e,userId,ctx:{...admin,userId,personId:e.personId,roles:['employee'],grants:undefined} as SessionContext};
}

/** A native Part 3 whose pinned form version carries the rows (optionally naming the employee). `departmentHead` names who heads the employee's department. */
async function caseWithRows(choose:ProbationApprovalRow[]|((people:{staff:string})=>ProbationApprovalRow[]),groups:(people:{staff:string})=>{id:string;name:string;members:string[];limit:number}[]=()=>[],options:{departmentHead?:'peer'|'staff'}={}){
 const[hrPerson]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional HR Partner',${randomUUID()+'@probation.example.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${hrPerson.id}::uuid where id=${admin.userId}::uuid`);admin={...admin,personId:hrPerson.id};
 const staff=await person('Fictional Staff'),manager=await person('Fictional Manager'),peer=await person('Fictional Peer');
 const allGroups=[{id:'probation-people',name:'Fictional People Ops',members:[admin.userId!],limit:10},...groups({staff:staff.userId})];
 await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:9,peopleOpsGroup:'probation-people',groups:allGroups})}::jsonb)`);
 await saveBusinessPartners([{rules:{company:[b.companyId]},userId:admin.userId!}]);
 await owner.db.execute(sql`insert into lc_onboarding_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({groups:allGroups})}::jsonb)`);
 await owner.db.execute(sql`update employment set probation_value=0,probation_months=0 where id in(${manager.employmentId}::uuid,${peer.employmentId}::uuid)`);
 await owner.db.execute(sql`update employment set probation_unit='month',probation_value=12,probation_months=12,probation_end_date='2026-12-31' where id=${staff.employmentId}::uuid`);
 const ids={caseId:randomUUID(),settings:randomUUID(),form:randomUUID(),route:randomUUID(),part:randomUUID()};
 const rows=typeof choose==='function'?choose({staff:staff.userId}):choose;
 const form={...DEFAULT_PROBATION_FORM,approvals:{'1':[],'2':[],'3':rows}};
 const part={...newProbationPart(ids.part,3,0,'2026-12-31',30),state:'issued' as const};
 const data={id:ids.caseId,employmentId:staff.employmentId,companyId:b.companyId,sourceKey:'employment:'+staff.employmentId,startOn:'2026-01-01',originalEndOn:'2026-12-31',endOn:'2026-12-31',gradeAtStart:'12',revision:1,config:DEFAULT_PROBATION_CONFIG,planMonths:12,planFlag:true,extensionCount:0,kpiAcknowledged:true,state:'in_review',pendingOutcome:null,facts:{employeeName:'Fictional Staff',holders:{employee:staff.userId,lm:null,hod:null,pbp:null}}};
 await owner.db.execute(sql`insert into probation_configuration(id,tenant_id,company_id,kind,version,state,data,created_by) values(${ids.settings}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'settings',1,'published',${JSON.stringify(DEFAULT_PROBATION_CONFIG)}::jsonb,${admin.userId}::uuid),(${ids.form}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'form',1,'published',${JSON.stringify(form)}::jsonb,${admin.userId}::uuid),(${ids.route}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'route',1,'published',${JSON.stringify(defaultProbationRoutes())}::jsonb,${admin.userId}::uuid)`);
 await owner.db.execute(sql`insert into probation_activation(tenant_id,company_id,enabled,activation_on,dry_run_digest,approved_by) values(${b.tenantId}::uuid,${b.companyId}::uuid,true,'2026-01-01',${'a'.repeat(64)},${admin.userId}::uuid)`);
 await owner.db.execute(sql`insert into probation_case(id,tenant_id,company_id,employment_id,source_key,settings_id,form_id,route_id,data) values(${ids.caseId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${staff.employmentId}::uuid,${data.sourceKey},${ids.settings}::uuid,${ids.form}::uuid,${ids.route}::uuid,${JSON.stringify(data)}::jsonb)`);
 const {employee,manager:managerValues,employeeComments,kpis,support,strengths,development,managerComments,outcome,midpointStatus,justification,extensionMonths,...metadata}=part;
 void employee;void managerValues;void employeeComments;void kpis;void support;void strengths;void development;void managerComments;void outcome;void midpointStatus;void justification;void extensionMonths;
 await owner.db.execute(sql`insert into probation_part(id,tenant_id,case_id,data) values(${ids.part}::uuid,${b.tenantId}::uuid,${ids.caseId}::uuid,${JSON.stringify({...metadata,route:defaultProbationRoutes().parts['3']})}::jsonb)`);
 const blank=Object.fromEntries(DEFAULT_PROBATION_FORM.criteria.map(c=>[c.id,{rating:null,evidence:''}]));
 await owner.db.execute(sql`insert into probation_rater_draft(part_id,tenant_id,rater,data) values(${ids.part}::uuid,${b.tenantId}::uuid,'employee',${JSON.stringify({employee:blank,employeeComments:''})}::jsonb),(${ids.part}::uuid,${b.tenantId}::uuid,'lm',${JSON.stringify({manager:blank})}::jsonb)`);
 await setReportingLine(admin,{subordinateEmploymentId:staff.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2026-01-01'});
 await owner.db.execute(sql`update department set head_employment_id=${(options.departmentHead==='staff'?staff:peer).employmentId}::uuid where id=${b.deptA}::uuid`);
 await owner.db.execute(sql`insert into probation_access(tenant_id,user_id,company_id,role,valid_from,reason) values(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'pbp','2026-01-01','Fictional PBP opt-in'),(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'gbs','2026-01-01','Fictional GBS opt-in')`);
 const current=async(ctx:SessionContext)=>(await probationCase(ctx,ids.caseId)).parts[0];
 const prepare=async()=>{
  let p=await current(staff.ctx);await saveProbationDraft(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,rater:'employee',patch:{employee:assessment}});
  p=await current(staff.ctx);await actOnProbation(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,command:'submit_employee'});
  p=await current(manager.ctx);await saveProbationDraft(manager.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,rater:'lm',patch:{manager:assessment,reviewOn:todayInKualaLumpur(),conductedBy:manager.userId,outcome:'confirm',justification:'Observed evidence supports confirmation'}});
 };
 const submit=async()=>{const p=await current(manager.ctx);await actOnProbation(manager.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,command:'submit_manager',method:'typed',value:'Fictional Manager',consent:true});};
 const acknowledge=async()=>{
  let p=await current(staff.ctx);await saveProbationDraft(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,rater:'employee',patch:{employeeComments:'I acknowledge the review discussion.'}});
  p=await current(staff.ctx);await actOnProbation(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,command:'acknowledge',method:'typed',value:'Fictional Staff',consent:true});
 };
 const stored=async()=>(await owner.db.execute<{route:SigningRoute;override:boolean|null;policy:unknown;revision:number}>(sql`select data->'route' as route,(data->>'routeOverride')::boolean as override,data->'routePolicy' as policy,revision from probation_part where id=${ids.part}::uuid`))[0];
 const holders=async()=>[...await owner.db.execute<{step_id:string;holder_id:string;kind:string;represented_id:string|null}>(sql`select step_id,holder_id,kind,represented_id from probation_delegate where part_id=${ids.part}::uuid order by created_at,id`)];
 const events=async(type:string)=>(await owner.db.execute<{n:number}>(sql`select count(*)::int n from domain_event where aggregate_id=${ids.caseId}::uuid and event_type=${type}`))[0].n;
 return{ids,staff,manager,peer,admin,current,prepare,submit,acknowledge,stored,holders,events};
}
 return{person,caseWithRows,admin:()=>admin};
}
