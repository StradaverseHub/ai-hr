import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {withAccessDisplayRead} from '../core/access-configuration-lock';
import {withScopedLifecycleTenant} from '../core/module-gate';
import {updatePersonProfilePartial} from '../core/org';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {probationOutcomeFixture} from './helpers/probation-outcome-fixture';
import {newProbationLetterTemplate,PROBATION_NATIVE_PERSONNEL_GROUPS} from '../lib/probation-letter-template';
import {saveProbationLetterTemplate,prepareProbationLetter,readProbationLetter,actOnProbationLetter,readProbationLetterCompletion,saveProbationLetterCompletion,overrideProbationLetterCompletion,refreshProbationLetterCompletion,reviewProbationLetterPersonnel,editProbationLetterContent,probationTaskList,releaseProbationLetter,sweepProbation} from '../packs/probation/service';
import type {Field} from '../lib/lifecycle-v9-model';
import type {SessionContext} from '../db/client';
let b:Base;beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');});
const personal=['employee.icNo','race','religion','nationality','gender','marital','employee.passportNo','mobile','homePhone','personalEmail','address'];
const employment=['employee.empNo','employee.name','email','company.name','employee.department','employee.position','employee.supervisor','joiner.joinDate','leaver.lastDay'];
const field=(key:string,options:Partial<Field>={}):Field=>({id:'field-'+key.replaceAll('.','-'),label:key,type:'text',owner:'pmLocked',pmKey:key,required:false,sensitive:false,options:[],section:'main',when:null,...options});
async function fixture(fields:Field[],options:{legacy?:boolean;customMobile?:boolean;initialEdits?:Record<string,string>}={}){
 const f=await probationOutcomeFixture(b,adminCtx(b)).recordedConfirm();
 const template={...newProbationLetterTemplate('confirm','completion-'+randomUUID().slice(0,8),'Fictional native completion'),...(!options.legacy?{routingRegistry:'on-off-boarding' as const,routing:[{id:'hr',order:1,action:'sign' as const,owner:true,who:{kind:'group' as const,groupId:'probation-people'}},{id:'employee',order:2,action:'acknowledge' as const,owner:false,who:{kind:'employee' as const}}]}:{})};
 template.blocks=template.blocks.filter(block=>block.type!=='letterhead'&&(!options.legacy?block.type!=='signature':true));template.blocks.find(block=>block.id==='body')!.text=options.customMobile?'Private legacy custom answer: {mobile}':'Private wording for {employeeName}.';
 template.fields=fields;template.blocks.push(...fields.map(field=>({id:'block-'+field.id,type:'field' as const,fieldId:field.id,text:'',section:'main'})));if(!options.legacy)template.blocks.push({id:'hr-sign',type:'signature',role:'step:hr',text:'',section:'main'},{id:'employee-sign',type:'signature',role:'step:employee',text:'',section:'main'});
 const templateId=await saveProbationLetterTemplate(f.admin,{companyId:b.companyId,template,publish:true,expectedVersion:0});
 const prepared=await prepareProbationLetter(f.admin,{outcomeId:f.decision.id,templateId,revision:f.decision.revision,edits:options.initialEdits??(options.customMobile?{mobile:'Retained case-only custom answer'}:{})});
 return{...f,template,templateId,partId:prepared.partId};
}
const view=async(f:Awaited<ReturnType<typeof fixture>>,ctx:SessionContext=f.admin)=>{
 const result=await readProbationLetterCompletion(ctx,{caseId:f.ids.caseId,partId:f.partId});if(!result)throw new Error('Expected an adopted native policy');return result;
};
it('classifies all twenty native keys, grants only own field preparation before HR first signing, and never submits or pushes by saving',async()=>{
 const fields=PROBATION_NATIVE_PERSONNEL_GROUPS.flatMap(group=>group.fields.map(item=>field(item.key,{type:item.type??'text',required:item.key==='mobile'}))),f=await fixture(fields),hr=await view(f),own=await view(f,f.staff.ctx);
 expect(Object.values(hr.document.personnelCompletion!.fields).map(entry=>entry.key).sort()).toEqual([...personal,...employment].sort());expect(Object.values(hr.document.personnelCompletion!.fields).filter(entry=>entry.group==='personal').map(entry=>entry.key).sort()).toEqual([...personal].sort());
 expect(hr.document.fields.map(field=>field.pmKey)).toEqual(fields.map(field=>field.pmKey));expect(hr.document.values['field-employee-name']).toBe('Fictional Staff');expect(own.document.fields.map(field=>field.pmKey).sort()).toEqual([...personal].sort());expect(own.document.blocks).toEqual([]);expect(own.document.mergeValues).toEqual({});expect(own.document.signing).toBeUndefined();
 await expect(readProbationLetter(f.staff.ctx,f.ids.caseId,f.partId)).rejects.toThrow();
 let letter=await readProbationLetter(f.admin,f.ids.caseId,f.partId);await expect(actOnProbationLetter(f.admin,{caseId:f.ids.caseId,partId:f.partId,revision:letter.storageRevision,stepId:'hr',action:'signed',method:'typed',value:'Fictional HR',consent:true})).rejects.toThrow();
 await saveProbationLetterCompletion(f.staff.ctx,{caseId:f.ids.caseId,partId:f.partId,revision:own.storageRevision,values:{'field-mobile':'0123456789'},reason:'Save my own missing mobile draft'});
 let current=await view(f,f.staff.ctx);expect(current.document.values['field-mobile']).toBe('+60123456789');expect(current.document.personnelCompletion!.submitted).toBeUndefined();expect((await view(f)).proposals).toEqual([]);
 letter=await readProbationLetter(f.admin,f.ids.caseId,f.partId);expect(letter.signing!.document.actions).toEqual([]);await expect(actOnProbationLetter(f.admin,{caseId:f.ids.caseId,partId:f.partId,revision:letter.storageRevision,stepId:'hr',action:'signed',method:'typed',value:'Fictional HR',consent:true})).rejects.toThrow('submit');
 await saveProbationLetterCompletion(f.staff.ctx,{caseId:f.ids.caseId,partId:f.partId,revision:current.storageRevision,values:{'field-mobile':'+60123456789'},submit:true,reason:'Submit my completed missing personal detail'});
 const after=await view(f);expect(after.proposals).toHaveLength(1);expect(after.proposals[0]).toMatchObject({field:'mobile',before:'',after:'+60123456789',status:'proposed',provenance:{kind:'missing-personnel',by:{id:f.staff.userId}}});
 const[p]=await owner.db.execute<{phone:string|null}>(sql`select phone from person where id=${f.staff.personId}::uuid`);expect(p.phone).toBeNull();
 letter=await readProbationLetter(f.admin,f.ids.caseId,f.partId);expect(letter.signing!.document.actions).toEqual([]);await actOnProbationLetter(f.admin,{caseId:f.ids.caseId,partId:f.partId,revision:letter.storageRevision,stepId:'hr',action:'signed',method:'typed',value:'Fictional HR',consent:true});
 const frozen=(await readProbationLetter(f.admin,f.ids.caseId,f.partId)).document.personnelCompletion;current=await view(f,f.staff.ctx);expect(current.canEdit).toBe(false);await expect(refreshProbationLetterCompletion(f.staff.ctx,{caseId:f.ids.caseId,partId:f.partId,revision:current.storageRevision})).rejects.toThrow();
 expect((await readProbationLetter(f.admin,f.ids.caseId,f.partId)).document.personnelCompletion).toEqual(frozen);
});
it.each([{key:'mobile',type:'phone',value:'12345'},{key:'personalEmail',type:'email',value:'bad@@example.test'},{key:'address',type:'date',value:'2026-02-30'},{key:'address',type:'number',value:'NaN'}] as const)('rejects invalid $type answers before storing any source or signing revision',async({key,type,value})=>{
 const f=await fixture([field(key,{type,required:true})]),before=await view(f,f.staff.ctx);
 await expect(saveProbationLetterCompletion(f.staff.ctx,{caseId:f.ids.caseId,partId:f.partId,revision:before.storageRevision,values:{[field(key).id]:value},submit:true,reason:'Try invalid typed value'})).rejects.toThrow();
 const after=await view(f,f.staff.ctx);expect(after.storageRevision).toBe(before.storageRevision);expect(after.document.values).toEqual(before.document.values);expect((await view(f)).proposals).toEqual([]);
});
it('records HR overrides without changing PM, preserves an employee draft after takeover and refuses stale review',async()=>{
 const f=await fixture([field('leaver.lastDay',{type:'date',required:true}),field('mobile',{type:'phone'})]);let hr=await view(f);
 expect(hr.document.personnelCompletion!.fields['field-leaver-lastDay'].group).toBe('employment');
 await expect(saveProbationLetterCompletion(f.staff.ctx,{caseId:f.ids.caseId,partId:f.partId,revision:hr.storageRevision,values:{'field-leaver-lastDay':'2026-12-31'},reason:'Try changing an HR field'})).rejects.toThrow();
 await overrideProbationLetterCompletion(f.admin,{caseId:f.ids.caseId,partId:f.partId,revision:hr.storageRevision,fieldId:'field-leaver-lastDay',owner:'employee',reason:'Ask the subject to confirm the missing planned date'});
 let own=await view(f,f.staff.ctx);await saveProbationLetterCompletion(f.staff.ctx,{caseId:f.ids.caseId,partId:f.partId,revision:own.storageRevision,values:{'field-leaver-lastDay':'2026-12-31'},submit:true,reason:'Submit my requested date'});
 hr=await view(f);expect(hr.proposals).toHaveLength(1);expect(hr.writableKeys).not.toContain('leaver.lastDay');await expect(reviewProbationLetterPersonnel(f.admin,{caseId:f.ids.caseId,partId:f.partId,revision:hr.storageRevision,ids:[hr.proposals[0].id],action:'push'})).rejects.toThrow('mapping review');
 await overrideProbationLetterCompletion(f.admin,{caseId:f.ids.caseId,partId:f.partId,revision:hr.storageRevision,fieldId:'field-leaver-lastDay',owner:'hr',reason:'HR will confirm this employment-owned date'});
 own=await view(f,f.staff.ctx);expect(own.document.personnelCompletion!.fields['field-leaver-lastDay'].draft?.value).toBe('2026-12-31');expect(own.document.values['field-leaver-lastDay']).toBe('');hr=await view(f);expect(hr.proposals[0].status).toBe('rejected');
 await expect(reviewProbationLetterPersonnel(f.admin,{caseId:f.ids.caseId,partId:f.partId,revision:hr.storageRevision,ids:[hr.proposals[0].id],action:'push'})).rejects.toThrow();
 const[e]=await owner.db.execute<{last_working_date:string|null}>(sql`select last_working_date::text from employment where id=${f.staff.employmentId}::uuid`);expect(e.last_working_date).toBeNull();
});
it('reconciles a real PM update before submission, locks the official value and preserves the conflicting saved employee draft',async()=>{
 const f=await fixture([field('mobile',{type:'phone',required:true})]);let own=await view(f,f.staff.ctx);
 await saveProbationLetterCompletion(f.staff.ctx,{caseId:f.ids.caseId,partId:f.partId,revision:own.storageRevision,values:{'field-mobile':'0123456789'},reason:'Save my personal draft'});
 await updatePersonProfilePartial(f.admin,{personId:f.staff.personId,via:'Fictional reviewed PM correction',phone:'+601112345678'});
 own=await view(f,f.staff.ctx);expect(own.document.values['field-mobile']).toBe('+601112345678');expect(own.document.personnelCompletion!.fields['field-mobile'].conflict?.draft).toBe('+60123456789');expect(own.document.fields).toHaveLength(1);
 await refreshProbationLetterCompletion(f.staff.ctx,{caseId:f.ids.caseId,partId:f.partId,revision:own.storageRevision});
 const current=await view(f);expect(current.document.values['field-mobile']).toBe('+601112345678');expect(current.document.personnelCompletion!.fields['field-mobile'].draft?.value).toBe('+60123456789');expect(current.proposals).toEqual([]);
});
it('uses the actual Personnel writer only after HR selects a submitted proposal, while keeping every signed snapshot unchanged',async()=>{
 const f=await fixture([field('mobile',{type:'phone',required:true}),field('address')]);let own=await view(f,f.staff.ctx);
 await saveProbationLetterCompletion(f.staff.ctx,{caseId:f.ids.caseId,partId:f.partId,revision:own.storageRevision,values:{'field-mobile':'0123456789','field-address':'Fictional case address'},submit:true,reason:'Submit my personal details for review'});
 let letter=await readProbationLetter(f.admin,f.ids.caseId,f.partId);await actOnProbationLetter(f.admin,{caseId:f.ids.caseId,partId:f.partId,revision:letter.storageRevision,stepId:'hr',action:'signed',method:'typed',value:'Fictional HR',consent:true});
 const frozen=(await readProbationLetter(f.admin,f.ids.caseId,f.partId)).document;let hr=await view(f);const phone=hr.proposals.find(proposal=>proposal.field==='mobile')!;
 await expect(reviewProbationLetterPersonnel(f.staff.ctx,{caseId:f.ids.caseId,partId:f.partId,revision:hr.storageRevision,ids:[phone.id],action:'push'})).rejects.toThrow();
 await reviewProbationLetterPersonnel(f.admin,{caseId:f.ids.caseId,partId:f.partId,revision:hr.storageRevision,ids:[phone.id],action:'push'});
 const[p]=await owner.db.execute<{phone:string|null;address:string|null}>(sql`select phone,address from person where id=${f.staff.personId}::uuid`);expect(p).toEqual({phone:'+60123456789',address:null});
 hr=await view(f);expect(hr.proposals.find(proposal=>proposal.id===phone.id)?.status).toBe('pushed');expect(hr.proposals.find(proposal=>proposal.field==='address')?.status).toBe('proposed');expect(hr.writableKeys).not.toContain('address');
 expect((await readProbationLetter(f.admin,f.ids.caseId,f.partId)).document).toEqual(frozen);
});
it('preserves declared legacy custom IDs and null legacy completion, refusing an ambiguous new PM link instead of guessing',async()=>{
 const custom=field('mobile',{id:'mobile',owner:'hr',pmKey:null,required:true}),f=await fixture([custom],{legacy:true,customMobile:true});expect(await readProbationLetterCompletion(f.admin,{caseId:f.ids.caseId,partId:f.partId})).toBeNull();
 const old=await readProbationLetter(f.admin,f.ids.caseId,f.partId);expect(old.merge.mobile).toBe('Retained case-only custom answer');
 const native={...f.template,id:'ambiguous-'+randomUUID().slice(0,8),routingRegistry:'on-off-boarding' as const,fields:[custom,field('mobile')]};await expect(saveProbationLetterTemplate(f.admin,{companyId:b.companyId,template:native,publish:true,expectedVersion:0})).rejects.toThrow('ambiguous');
});
it('keeps the new reader PG read-only and equivalent under group/one-company scope at seventy companies and one thousand employments',async()=>{
 const f=await fixture([field('mobile',{type:'phone',required:true})]),before=await view(f);
 await owner.db.execute(sql`insert into company(tenant_id,legal_name,country,currency) select ${b.tenantId}::uuid,'Fictional native completion scale company '||n,'MY','MYR' from generate_series(1,70) n`);
 await owner.db.execute(sql`insert into person(tenant_id,full_name,primary_email) select ${b.tenantId}::uuid,'Fictional native completion scale person '||lpad(n::text,4,'0'),'native-completion-scale-'||n||'@example.test' from generate_series(1,1000) n`);
 await owner.db.execute(sql`with people as(select id,row_number() over(order by full_name) n from person where tenant_id=${b.tenantId}::uuid and full_name like 'Fictional native completion scale person %'),companies as(select id,row_number() over(order by legal_name)-1 k from company where tenant_id=${b.tenantId}::uuid and legal_name like 'Fictional native completion scale company %') insert into employment(tenant_id,person_id,company_id,hired_on) select ${b.tenantId}::uuid,p.id,c.id,'2026-01-01' from people p join companies c on c.k=(p.n-1)%70`);
 const[shape]=await owner.db.execute<{companies:number;employments:number}>(sql`select (select count(*)::int from company where tenant_id=${b.tenantId}::uuid and legal_name like 'Fictional native completion scale company %') companies,(select count(*)::int from employment e join person p on p.id=e.person_id where e.tenant_id=${b.tenantId}::uuid and p.full_name like 'Fictional native completion scale person %') employments`);expect(shape).toEqual({companies:70,employments:1000});
 expect(await view(f)).toEqual(before);expect(await view(f,{...f.admin,grants:[{role:'hr_admin',companyId:b.companyId}]})).toEqual(before);
 const proof=await withAccessDisplayRead(()=>withScopedLifecycleTenant(f.admin,async tx=>{await tx.execute(sql`select app.probation_letter_completion_read(${f.ids.caseId}::uuid,${f.partId}::uuid)`);const[mode]=await tx.execute<{readonly:string;rowlocks:number}>(sql`select current_setting('transaction_read_only') as readonly,(select count(*)::int from pg_locks where pid=pg_backend_pid() and mode='RowShareLock') rowlocks`);return mode;},{readOnlySnapshot:true}));expect(proof).toEqual({readonly:'on',rowlocks:0});
 await expect(view(f,f.peer.ctx)).rejects.toThrow();await expect(readProbationLetterCompletion(f.staff.ctx,{caseId:randomUUID(),partId:f.partId})).rejects.toThrow();
});
it('refuses policy/owner forgeries and alternate content writers while the new preparation changes no acknowledgement or task history',async()=>{
 const f=await fixture([field('mobile',{type:'phone',required:true})]),before=await view(f,f.staff.ctx);
 await expect(withTenant(f.staff.ctx,tx=>tx.execute(sql`update probation_part set data=jsonb_set(data,'{personnelCompletion,fields,field-mobile,sourceValue}','"Forged official value"') where id=${f.partId}::uuid`))).rejects.toThrow();
 await expect(withTenant(f.staff.ctx,tx=>tx.execute(sql`select * from probation_letter_completion_custody`))).rejects.toThrow();
 await expect(withTenant(f.staff.ctx,tx=>tx.execute(sql`select app.probation_content(${f.partId}::uuid)`))).rejects.toThrow();
 await expect(withTenant(f.staff.ctx,tx=>tx.execute(sql`select app.probation_letter_completion_update(${f.ids.caseId}::uuid,${f.partId}::uuid,${before.storageRevision},'{}','override','Forged employee override',${JSON.stringify({fieldId:'field-mobile',owner:'hr'})}::jsonb)`))).rejects.toThrow();
 await expect(withTenant(f.admin,tx=>tx.execute(sql`select app.probation_letter_edit_content(${f.partId}::uuid,${before.storageRevision},'{"body":"Alternate unchecked edit"}','{}','Try bypassing native custody')`))).rejects.toThrow('custodian');
 expect((await view(f,f.staff.ctx)).storageRevision).toBe(before.storageRevision);expect((await readProbationLetter(f.admin,f.ids.caseId,f.partId)).signing!.document.actions).toEqual([]);
});

it('projects preparation on the existing task identity, then restores the untouched HR-first signing route only after explicit submission',async()=>{
 const f=await fixture([field('mobile',{type:'phone',required:true})]);const route=(await readProbationLetter(f.admin,f.ids.caseId,f.partId)).signing!.document.route;
 const tasks=await probationTaskList(f.staff.ctx,{category:'task'});expect(tasks.items.find(item=>item.partId===f.partId)).toMatchObject({kind:'letter_prepare',href:`/lifecycle/probation/${f.ids.caseId}/letters/${f.partId}`});
 expect((await probationTaskList(f.admin,{category:'task'})).items.some(item=>item.partId===f.partId)).toBe(false);
 let own=await view(f,f.staff.ctx);await saveProbationLetterCompletion(f.staff.ctx,{caseId:f.ids.caseId,partId:f.partId,revision:own.storageRevision,values:{'field-mobile':'0123456789'},reason:'Save without submitting'});
 expect((await probationTaskList(f.staff.ctx,{category:'task'})).items.find(item=>item.partId===f.partId)?.kind).toBe('letter_prepare');
 own=await view(f,f.staff.ctx);await saveProbationLetterCompletion(f.staff.ctx,{caseId:f.ids.caseId,partId:f.partId,revision:own.storageRevision,values:{'field-mobile':'0123456789'},submit:true,reason:'Submit only the requested field preparation'});
 expect((await probationTaskList(f.staff.ctx,{category:'task'})).items.some(item=>item.partId===f.partId)).toBe(false);expect((await probationTaskList(f.admin,{category:'task'})).items.find(item=>item.partId===f.partId)?.kind).toBe('letter_sign');
 const letter=await readProbationLetter(f.admin,f.ids.caseId,f.partId);expect(letter.signing!.document.route).toEqual(route);expect(letter.signing!.document.actions).toEqual([]);
});
it('never changes the waiting owner or blocks the first HR signature for an optional missing personal answer',async()=>{
 const f=await fixture([field('address')]);expect((await probationTaskList(f.staff.ctx,{category:'task'})).items.some(item=>item.partId===f.partId)).toBe(false);
 const letter=await readProbationLetter(f.admin,f.ids.caseId,f.partId);await actOnProbationLetter(f.admin,{caseId:f.ids.caseId,partId:f.partId,revision:letter.storageRevision,stepId:'hr',action:'signed',method:'typed',value:'Fictional HR',consent:true});
 expect((await view(f,f.staff.ctx)).document.values['field-address']).toBe('');
});
it('resolves a private ordinary conditional control without disclosing it or changing the frozen field structure',async()=>{
 const gate=field('gate',{id:'gate',type:'checkbox',owner:'hr',pmKey:null}),phone=field('mobile',{type:'phone',required:true,when:{field:'gate',value:'true'}}),f=await fixture([gate,phone],{initialEdits:{gate:'false'}});
 expect((await view(f,f.staff.ctx)).document.fields).toEqual([]);let letter=await readProbationLetter(f.admin,f.ids.caseId,f.partId);
 await editProbationLetterContent(f.admin,{caseId:f.ids.caseId,partId:f.partId,revision:letter.storageRevision,edits:{},values:{gate:'true'},reason:'Activate the requested personal detail'});
 const own=await view(f,f.staff.ctx);expect(own.document.fields).toHaveLength(1);expect(own.document.fields[0]).toMatchObject({id:'field-mobile',when:null});expect(own.document.values).toEqual({'field-mobile':''});expect(own.document.personnelCompletion!.fields.gate).toBeUndefined();
 letter=await readProbationLetter(f.admin,f.ids.caseId,f.partId);expect(letter.fields.find(field=>field.id==='field-mobile')!.when).toEqual({field:'gate',value:'true'});
});

it('completes the actual native preparation, HR signature, employee acknowledgement and sealed outcome PDF without mutating the signed policy',async()=>{
 const f=await fixture([field('mobile',{type:'phone',required:true}),field('address')]);let own=await view(f,f.staff.ctx);
 await saveProbationLetterCompletion(f.staff.ctx,{caseId:f.ids.caseId,partId:f.partId,revision:own.storageRevision,values:{'field-mobile':'0123456789'},submit:true,reason:'Submit my missing phone before signatures'});
 let letter=await readProbationLetter(f.admin,f.ids.caseId,f.partId);await actOnProbationLetter(f.admin,{caseId:f.ids.caseId,partId:f.partId,revision:letter.storageRevision,stepId:'hr',action:'signed',method:'typed',value:'Fictional HR',consent:true});
 letter=await readProbationLetter(f.staff.ctx,f.ids.caseId,f.partId);await actOnProbationLetter(f.staff.ctx,{caseId:f.ids.caseId,partId:f.partId,revision:letter.storageRevision,stepId:'employee',action:'signed',method:'typed',value:'Fictional Staff',consent:true});
 letter=await readProbationLetter(f.admin,f.ids.caseId,f.partId);const frozen=structuredClone(letter.document.personnelCompletion);expect(letter.document.status).toBe('signed');expect(letter.document.values['field-mobile']).toBe('+60123456789');
 await releaseProbationLetter(f.admin,{caseId:f.ids.caseId,partId:f.partId,outcomeRevision:letter.outcomeRevision!,reason:'Release the signed fictional completion letter'});
 const runner={...f.admin,userId:undefined,roles:[],grants:undefined};const port={withTenant:async<T>(ctx:SessionContext,work:(tx:import('../db/client').Tx)=>Promise<T>)=>owner.withTenant(ctx,work)};await sweepProbation(runner,port);await sweepProbation(runner,port);
 const[row]=await owner.db.execute<{pdf:Buffer;policy:unknown;files:number}>(sql`select file.content as pdf,part.data->'personnelCompletion' as policy,(select count(*)::int from probation_file where tenant_id=${b.tenantId}::uuid and case_id=${f.ids.caseId}::uuid and kind='letter_released') as files from probation_outcome outcome join probation_file file on file.id=outcome.letter_file_id and file.tenant_id=outcome.tenant_id join probation_part part on part.id=outcome.letter_part_id and part.tenant_id=outcome.tenant_id where outcome.id=${f.decision.id}::uuid and outcome.released_at is not null`);
 expect(row.pdf.subarray(0,5).toString()).toBe('%PDF-');expect(row.policy).toEqual(frozen);expect(row.files).toBe(1);
});
it('keeps a retained custom mobile identity case-only in a newly converted native letter instead of treating it as Personnel',async()=>{
 const custom=field('mobile',{id:'mobile',owner:'hr',pmKey:null,required:true}),f=await fixture([custom],{customMobile:true});let letter=await readProbationLetter(f.admin,f.ids.caseId,f.partId);
 expect(letter.merge.mobile).toBe('Retained case-only custom answer');expect(letter.document.personnelCompletion!.fields.mobile).toBeUndefined();expect((await view(f)).document.fields).toEqual([]);
 await editProbationLetterContent(f.admin,{caseId:f.ids.caseId,partId:f.partId,revision:letter.storageRevision,edits:{},values:{mobile:'Reviewed case-only custom answer'},reason:'Preserve the declared historical field identity'});
 letter=await readProbationLetter(f.admin,f.ids.caseId,f.partId);expect(letter.merge.mobile).toBe('Reviewed case-only custom answer');expect((await view(f)).proposals).toEqual([]);
 const[p]=await owner.db.execute<{phone:string|null}>(sql`select phone from person where id=${f.staff.personId}::uuid`);expect(p.phone).toBeNull();
});
it('serializes a real Personnel update with first signing and preserves either valid frozen order without losing the saved answer',async()=>{
 const f=await fixture([field('mobile',{type:'phone',required:true})]);let own=await view(f,f.staff.ctx);
 await saveProbationLetterCompletion(f.staff.ctx,{caseId:f.ids.caseId,partId:f.partId,revision:own.storageRevision,values:{'field-mobile':'0123456789'},submit:true,reason:'Submit the answer before the concurrent PM update'});
 const letter=await readProbationLetter(f.admin,f.ids.caseId,f.partId),submitted=structuredClone(letter.document.personnelCompletion);
 const[profile,signature]=await Promise.allSettled([updatePersonProfilePartial(f.admin,{personId:f.staff.personId,via:'Fictional concurrent PM correction',phone:'+601112345678'}),actOnProbationLetter(f.admin,{caseId:f.ids.caseId,partId:f.partId,revision:letter.storageRevision,stepId:'hr',action:'signed',method:'typed',value:'Fictional HR',consent:true})]);expect(profile.status).toBe('fulfilled');
 const current=await readProbationLetter(f.admin,f.ids.caseId,f.partId);
 if(signature.status==='fulfilled'){expect(current.document.personnelCompletion).toEqual(submitted);expect(current.document.values['field-mobile']).toBe('+60123456789');expect(current.signing!.document.actions.filter(action=>action.action==='signed')).toHaveLength(1);}
 else{expect(current.signing!.document.actions).toEqual([]);own=await view(f,f.staff.ctx);expect(own.document.values['field-mobile']).toBe('+601112345678');expect(own.document.personnelCompletion!.fields['field-mobile'].conflict?.draft).toBe('+60123456789');}
});
