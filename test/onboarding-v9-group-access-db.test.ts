import {beforeEach,afterAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {saveEmployeeDraft} from '../core/employee-draft';
import {hireEmployee} from '../core/org';
import {onboardingContext,onboardingList,onboardingDetail,onboardingCommand,onboardingSaveConfig,onboardingNote,onboardingMarkSeen,onboardingNavigation,v9Setup,v9Workspace} from '../packs/lifecycle/service';
import {defaultV9CaseFields} from '../lib/lifecycle-v9-case-form';
import {joinerPageSections} from '../lib/onboarding-page-access';
import {closeAll,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
let base:Base,admin:SessionContext,member:SessionContext,id:string;
afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'lifecycle','active');admin=await entitledCtx(base);await v9Setup(admin);
 const manager=await hireEmployee(admin,{companyId:base.companyId,departmentId:base.deptA,positionId:base.positionId,employmentType:'full_time',hiredOn:'2026-01-01',person:{fullName:'Fictional access reviewer',primaryEmail:'reviewer@example.test'}});
 member={...admin,userId:await createAppUser(base.tenantId,manager.personId,'employee'),personId:manager.personId,roles:['employee'],grants:undefined};
 const context=await onboardingContext(admin);context.config.groups.push({id:'page-readers',name:'Fictional case viewers',members:[member.userId!],limit:0});context.config.access.joinerViewGroups=['page-readers'];context.config.access.joinerSections={'page-readers':{preset:'coord'}};await onboardingSaveConfig(admin,context.revision,context.config);
 const draft=await saveEmployeeDraft(admin,{currentStep:1,data:{profile:{fullName:'Fictional group case subject',primaryEmail:'subject@example.test',icNumber:'PRIVATE-GROUP-IC'},employment:{companyId:base.companyId,departmentId:base.deptA,positionId:base.positionId,reportingManagerEmploymentId:manager.employmentId,hiredOn:'2026-11-10'}}});id=(await onboardingList(admin)).find(row=>row.case.sourceDraftId===draft.id)!.case.id;
});
it('matches all source presets and combinations in SQL without turning the legacy participant into a page writer',async()=>{
 for(const preset of ['full','coord','fulfil','approver','custom'] as const){const context=await onboardingContext(admin);context.config.access.joinerSections!['page-readers']={preset,...(preset==='custom'?{s:{case:'hidden' as const,history:'hidden' as const}}:{})};await onboardingSaveConfig(admin,context.revision,context.config);
 const result=await withTenant(member,tx=>tx.execute<{sections:unknown;participant:boolean}>(sql`select app.onboarding_v9_sections() as sections,app.onboarding_participant(${id}::uuid) as participant`));expect(result[0].sections).toEqual(joinerPageSections(context.config,member.userId!));expect(result[0].participant).toBe(false);}
 const context=await onboardingContext(admin);context.config.groups.push({id:'second',name:'Second group',members:[member.userId!],limit:0});context.config.access.joinerViewGroups!.push('second');context.config.access.joinerSections!.second={preset:'coord'};await onboardingSaveConfig(admin,context.revision,context.config);expect((await withTenant(member,tx=>tx.execute<{sections:unknown}>(sql`select app.onboarding_v9_sections() as sections`)))[0].sections).toEqual(joinerPageSections(context.config,member.userId!));
});
it('keeps view-only groups read-only through services and application-role SQL, then honors explicit case actions, revisions and revocation',async()=>{
 expect(await onboardingNavigation(member)).toMatchObject({module:false,v9:true,v9Navigation:{onboarding:true,offboarding:false,administration:false}});const read=await onboardingDetail(member,id);expect(read.actor).toMatchObject({module:false,page:true,caseActions:false,hr:false});expect(JSON.stringify(read)).not.toContain('PRIVATE-GROUP-IC');expect((await v9Workspace(member)).permissions?.onboarding).toBe(true);
 await onboardingMarkSeen(member,id);await onboardingMarkSeen(member,id);expect((await onboardingList(member)).find(row=>row.case.id===id)?.isNew).toBe(false);expect((await onboardingDetail(member,id)).revision).toBe(read.revision);
 for(const command of [{type:'save',patch:{floor:'Denied'}},{type:'submit'},{type:'cancel',reason:'Denied'},{type:'reopen'}] as const)await expect(onboardingCommand(member,id,read.revision,command)).rejects.toThrow();
 expect(await withTenant(member,tx=>tx.execute(sql`update lc_onboarding_case set data=jsonb_set(data,'{floor}','"Denied direct SQL"') where id=${id}::uuid returning id`))).toHaveLength(0);
 let context=await onboardingContext(admin);context.config.access.joinerSections!['page-readers']={preset:'full'};await onboardingSaveConfig(admin,context.revision,context.config);
 let detail=await onboardingDetail(member,id);expect(detail.actor).toMatchObject({module:false,caseActions:true,hr:false});await onboardingCommand(member,id,detail.revision,{type:'save',patch:{hiring:'new_hire',floor:'Reviewed floor'}});
 await expect(onboardingCommand(member,id,detail.revision,{type:'save',patch:{floor:'Stale'}})).rejects.toThrow('changed');detail=await onboardingDetail(member,id);await onboardingCommand(member,id,detail.revision,{type:'submit'});
 detail=await onboardingDetail(member,id);expect(detail.case.state).toBe('submitted');await onboardingCommand(member,id,detail.revision,{type:'cancel',reason:'Fictional approved cancellation'});detail=await onboardingDetail(member,id);await onboardingCommand(member,id,detail.revision,{type:'reopen'});expect((await onboardingDetail(member,id)).case.state).toBe('pending');
 context=await onboardingContext(admin);context.config.access.joinerViewGroups=[];await onboardingSaveConfig(admin,context.revision,context.config);await expect(onboardingDetail(member,id)).rejects.toThrow();await expect(onboardingList(member)).rejects.toThrow();
});
it('redacts hidden sections and HR facts before serialization and rejects hidden-section edits even with custom case actions',async()=>{
 const context=await onboardingContext(admin);context.config.access.joinerSections!['page-readers']={preset:'custom',s:{case:'hidden',notes:'hidden',checklist:'hidden',equip:'hidden',history:'hidden',actions:'allowed'}};await onboardingSaveConfig(admin,context.revision,context.config);
 const detail=await onboardingDetail(member,id);expect(detail.case).toMatchObject({tasks:[],requisitions:[],history:[],notes:'',floor:''});expect(detail.notes).toEqual([]);expect(detail.case.caseValues).toBeUndefined();expect(JSON.stringify(detail.case)).not.toContain('PRIVATE-GROUP-IC');
 for(const patch of [{floor:'Hidden edit'},{notes:'Hidden note'},{checklistOverride:'none'},{selected:['hidden-equipment']}])await expect(onboardingCommand(member,id,detail.revision,{type:'save',patch})).rejects.toThrow('hidden or read-only');
 await expect(onboardingCommand(member,id,detail.revision,{type:'save',patch:{local:{ic:'Forbidden identity'}}})).rejects.toThrow();
});
it('keeps record-group access independent and read-only without exposing a joiner page or private workspace metadata',async()=>{
 const context=await onboardingContext(admin);context.config.access.joinerViewGroups=[];context.config.access.recordGroups=['page-readers'];await onboardingSaveConfig(admin,context.revision,context.config);
 const rows=await onboardingList(member);expect(rows.find(row=>row.case.id===id)?.case).toMatchObject({tasks:[],history:[],notes:''});await expect(onboardingDetail(member,id)).rejects.toThrow();
 const workspace=await v9Workspace(member);expect(workspace.permissions).toMatchObject({onboarding:false,offboarding:false,administration:false,records:true});expect(workspace.config).toMatchObject({templates:[],emails:[],workflows:[],bpRules:[]});expect(workspace.options.employees).toEqual([]);
 await expect(onboardingCommand(member,id,rows[0].revision,{type:'save',patch:{floor:'Denied record edit'}})).rejects.toThrow();
 expect(await withTenant(member,tx=>tx.execute(sql`update lc_onboarding_case set data=jsonb_set(data,'{floor}','"Denied record SQL"') where id=${id}::uuid returning id`))).toHaveLength(0);
});
it('uses fresh membership and tenant identity, rejects HR-only field writes, and preserves a public custom answer on the private owner',async()=>{
 const config=(await v9Workspace(admin)).config!;config.caseForms={...config.caseForms,onb:defaultV9CaseFields('onb')};config.caseForms.onb!.push({key:'publicReview',label:'Fictional public review',type:'text',show:true,required:false,hrOnly:false,rules:{},options:[],help:''},{key:'privateReview',label:'Fictional HR review',type:'text',show:true,required:false,hrOnly:true,rules:{},options:[],help:''});
 await (await import('../packs/lifecycle/service')).v9SaveConfig(admin,config.revision,config);
 let context=await onboardingContext(admin);context.config.access.joinerSections!['page-readers']={preset:'full'};await onboardingSaveConfig(admin,context.revision,context.config);
 let detail=await onboardingDetail(member,id);await onboardingCommand(member,id,detail.revision,{type:'save',patch:{caseValues:{publicReview:'Fictional reviewed answer'}}});detail=await onboardingDetail(member,id);expect(detail.case.caseValues?.publicReview).toBe('Fictional reviewed answer');
 await expect(onboardingCommand(member,id,detail.revision,{type:'save',patch:{caseValues:{privateReview:'Forbidden HR answer'}}})).rejects.toThrow('HR access');
 const foreign=await seedBase();await expect(onboardingDetail({...member,tenantId:foreign.tenantId},id)).rejects.toThrow();
 context=await onboardingContext(admin);context.config.groups.find(group=>group.id==='page-readers')!.members=[];await onboardingSaveConfig(admin,context.revision,context.config);await expect(onboardingDetail(member,id)).rejects.toThrow();
});
it('revokes SQL page/record capabilities for an archived account even with a captured session and retained group membership',async()=>{
 const context=await onboardingContext(admin);context.config.access.recordGroups=['page-readers'];await onboardingSaveConfig(admin,context.revision,context.config);
 await owner.client`update app_user set archived_at=now() where id=${member.userId!}::uuid and tenant_id=${base.tenantId}::uuid`;
 const [permissions]=await withTenant(member,tx=>tx.execute<{sections:unknown;records:boolean;actions:boolean}>(sql`select app.onboarding_v9_sections() as sections,app.onboarding_v9_record_reader() as records,app.onboarding_v9_case_actor() as actions`));expect(permissions).toEqual({sections:null,records:false,actions:false});
});

it('lets an allowed case actor author and edit case notes while a view-only group cannot post',async()=>{
 let detail=await onboardingDetail(member,id);await expect(onboardingNote(member,id,{context:'case',body:'Denied viewer note',mentions:[]})).rejects.toThrow();
 const context=await onboardingContext(admin);context.config.access.joinerSections!['page-readers']={preset:'full'};await onboardingSaveConfig(admin,context.revision,context.config);
 await onboardingNote(member,id,{context:'case',body:'Fictional group case note',mentions:[]});detail=await onboardingDetail(member,id);const note=detail.notes.find(note=>note.body==='Fictional group case note')!;expect(note.by).toBe(member.userId);
 await onboardingNote(member,id,{id:note.id,context:'case',body:'Fictional revised group note',mentions:[]});expect((await onboardingDetail(member,id)).notes.find(candidate=>candidate.id===note.id)?.body).toBe('Fictional revised group note');
});
it('does not turn a scoped company HR viewer into a case writer or expose hidden HR/private workspace data',async()=>{
 const userId=await createAppUser(base.tenantId,member.personId!,'hr_admin');await owner.client`update role_assignment set company_id=${base.companyId}::uuid where tenant_id=${base.tenantId}::uuid and app_user_id=${userId}::uuid and role='hr_admin'`;
 const viewer:SessionContext={...member,userId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:base.companyId}]};const context=await onboardingContext(admin);context.config.groups.find(group=>group.id==='page-readers')!.members=[userId];await onboardingSaveConfig(admin,context.revision,context.config);
 const detail=await onboardingDetail(viewer,id);expect(detail.actor).toMatchObject({page:true,module:false,master:false,hr:false,caseActions:false});expect(JSON.stringify(detail)).not.toContain('PRIVATE-GROUP-IC');
 const workspace=await v9Workspace(viewer);expect(workspace.permissions?.administration).toBe(false);expect(workspace.config).not.toHaveProperty('settlementPolicy');expect(workspace.config).not.toHaveProperty('companies');expect(workspace.options.employees).toEqual([]);
 await expect(onboardingCommand(viewer,id,detail.revision,{type:'save',patch:{floor:'Denied HR viewer'}})).rejects.toThrow();
 expect(await withTenant(viewer,tx=>tx.execute(sql`update lc_onboarding_case set data=jsonb_set(data,'{floor}','"Denied HR SQL"') where id=${id}::uuid returning id`))).toHaveLength(0);
});
