/** Authored UNRUN actual app-role, strict browser and edit-baseline regressions. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {createClaimType,setClaimPolicy,saveClaimDraft,submitDraftClaims,createClaimFormField,addClaimAttachment} from '../packs/claims/service';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {erasePersonPii} from '../core/pdpa';
import {lockLeaveDependenciesTx} from '../packs/leave/service';
import {prepareOwnClaimDraftSourceTx,confirmOwnClaimDraftSourceTx} from '../core/assistant-actions/own-claim-source';
import {prepareClaimModuleActionReview,confirmClaimModuleActionReview,reopenClaimModuleActionReview,discardClaimModuleActionReview,listClaimModuleActionReviews} from '../core/assistant-actions/module-action-review-store';
import {ClaimModuleActionConfirmation,ClaimModuleActionPreparedReview,ModuleActionConfirmation} from '../lib/assistant-actions/module-action-review-contract';
import {OWN_CLAIM_DRAFT_ACTION,type OwnClaimDraftHumanContent} from '../lib/assistant-actions/own-claim-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined}));vi.mock('server-only',()=>({}));vi.mock('next/headers',()=>({cookies:async()=>({get:(key:string)=>key==='dev_user'&&browser.selected?{value:browser.selected}:undefined}),headers:async()=>new Headers()}));vi.mock('next-intl/server',()=>({getLocale:async()=>'en'}));vi.mock('../lib/workos',()=>({currentWorkosSession:async()=>null}));vi.mock('../lib/real-auth',()=>({appOrigin:()=>'https://fixture.test'}));
import {readClaimModuleActionChoices,readClaimModuleActionDraft,handleConfiguredModuleActionBrowserCommand} from '../core/assistant-actions/module-action-server';
let b:Base,ctx:SessionContext,subject:{personId:string;employmentId:string},human:OwnClaimDraftHumanContent,typeId:string;
const group=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());beforeEach(async()=>{
 vi.stubEnv('NODE_ENV','development');vi.stubEnv('REAL_AUTH','false');browser.selected=undefined;
 vi.stubEnv('AI_CONFIG_SECRET','fictional-claim-custody-key-123456789012345');
 await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');await setModule(b.tenantId,'claims','active');
 subject=await hireEmployee(group(),{person:{fullName:'Fictional Own Claimant',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,subject.personId,'employee');await grantAssistant(group(),{appUserId:userId});ctx={...await entitledCtx(b,['employee']),userId,personId:subject.personId,grants:[{role:'employee',companyId:null}]};
 browser.selected=userId;
 typeId=(await createClaimType(group(),{code:'FICTIONAL',name:'Fictional actual receipt',defaultTaxable:false,requiresReceipt:false})).id;
 await setClaimPolicy(group(),{claimTypeId:typeId,annualBudget:100,perClaimCap:100,effectiveFrom:todayInKualaLumpur()});
 human={action:OWN_CLAIM_DRAFT_ACTION,contractVersion:1,employmentId:subject.employmentId,draftId:null,claimTypeId:typeId,claimItemId:null,enteredAmount:200,quantityKm:null,incurredOn:todayInKualaLumpur(),description:'PRIVATE actual human receipt facts',fieldValues:null,retainedAttachmentIds:[]};
});

const prepare=async(actor=ctx,content:unknown=human)=>(await prepareClaimModuleActionReview(actor,content)).review;
const confirmation=(r:Awaited<ReturnType<typeof prepare>>)=>({action:OWN_CLAIM_DRAFT_ACTION,contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest});
const confirm=(r:Awaited<ReturnType<typeof prepare>>,actor=ctx)=>confirmClaimModuleActionReview(actor,confirmation(r));
const native=(content=human)=>({employmentId:content.employmentId,claimTypeId:content.claimTypeId,claimItemId:content.claimItemId,amount:content.enteredAmount,quantityKm:content.quantityKm,incurredOn:content.incurredOn,description:content.description,fieldValues:content.fieldValues,...content.draftId?{id:content.draftId}:{}});
async function state(){return{claims:await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.tenantId,b.tenantId)).orderBy(s.claimRequest.id),events:await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,b.tenantId),eq(s.domainEvent.eventType,'claim-request.draft-saved'))).orderBy(s.domainEvent.id)};}
async function custody(id:string){const [row]=await owner.db.execute<{state:string;intent:string|null;reviewed:string|null;draft:string|null;event:string|null;bodies:number}>(sql`select state,intent_digest as intent,reviewed_digest as reviewed,claim_draft_id as draft,claim_saved_event_id as event,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where r.id=${id}::uuid`);return row;}

const request=(packet:unknown)=>new Request('https://fixture.test/api/assistant/module-actions',{method:'POST',headers:{origin:'https://fixture.test','content-type':'application/json'},body:JSON.stringify(packet)});
it('choices expose all six native field kinds but no saved private answers, rates, balances or bytes; selected reads expose only active answers',async()=>{
 for(const kind of ['text','number','money','date','select','boolean'])await createClaimFormField(group(),{claimTypeId:typeId,label:'Fictional '+kind,fieldKey:'custom_'+kind,kind,options:kind==='select'?['A','B']:undefined});
 const saved=await saveClaimDraft(ctx,{...native(),fieldValues:{custom_text:'PRIVATE own answer',archived_secret:'PRIVATE hidden legacy'}});
 const before=await state(),choices=await readClaimModuleActionChoices(ctx);expect(choices.kind).toBe('choices');if(choices.kind!=='choices')throw Error('fixture choices');expect(choices.types[0].fields.map(row=>row.kind).sort()).toEqual(['boolean','date','money','number','select','text']);expect(JSON.stringify(choices)).not.toMatch(/PRIVATE|fieldValues|annualBudget|remaining|rateConfig|contentBytes/);expect(await state()).toEqual(before);
 const selected=await readClaimModuleActionDraft(ctx,{employmentId:subject.employmentId,draftId:saved.id});expect(selected.draft.fieldValues).toEqual({custom_text:'PRIVATE own answer'});expect(JSON.stringify(selected)).not.toContain('archived_secret');expect(await state()).toEqual(before);
});
it('refuses genuinely stale loaded xmin before preparing custody and preserves archived answers internally without public leakage',async()=>{
 await createClaimFormField(group(),{claimTypeId:typeId,label:'Project',fieldKey:'project',kind:'text'});const saved=await saveClaimDraft(ctx,{...native(),fieldValues:{project:'Before',archived_secret:'PRIVATE retained'}}),loaded=await readClaimModuleActionDraft(ctx,{employmentId:subject.employmentId,draftId:saved.id});
 await saveClaimDraft(ctx,{...native(),id:saved.id,description:'Actual intervening native edit',fieldValues:{project:'Intervening',archived_secret:'PRIVATE retained'}});const before=await state();await expect(prepare(ctx,{...human,draftId:saved.id,expectedDraftRevision:loaded.draft.draftRevision,fieldValues:{project:'After'}})).rejects.toThrow();expect(await state()).toEqual(before);expect((await listClaimModuleActionReviews(ctx)).reviews).toHaveLength(0);
 const current=await readClaimModuleActionDraft(ctx,{employmentId:subject.employmentId,draftId:saved.id}),r=await prepare(ctx,{...human,draftId:saved.id,expectedDraftRevision:current.draft.draftRevision,fieldValues:{project:'After'}});expect(JSON.stringify(r)).not.toContain('archived_secret');expect(JSON.stringify(r)).not.toContain('PRIVATE retained');await confirm(r);const [row]=await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,saved.id));expect(row.fieldValues).toEqual({project:'After',archived_secret:'PRIVATE retained'});
});
it('binds actual own selected drafts against same-tenant other people, forged login/person/tenant and fresh revocation',async()=>{
 const saved=await saveClaimDraft(ctx,native()),other=await hireEmployee(group(),{person:{fullName:'Fictional Other',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()}),userId=await createAppUser(b.tenantId,other.personId,'employee');await grantAssistant(group(),{appUserId:userId});const otherCtx={...ctx,userId,personId:other.personId};
 for(const actor of [otherCtx,{...ctx,personId:other.personId},{...ctx,tenantId:randomUUID()}])await expect(readClaimModuleActionDraft(actor,{employmentId:subject.employmentId,draftId:saved.id})).rejects.toThrow();const visible=await readClaimModuleActionChoices(otherCtx);if(visible.kind!=='choices')throw Error('fixture other choices');expect(visible.drafts).toEqual([]);
 await revokeAssistant(group(),{appUserId:ctx.userId!});expect(await readClaimModuleActionChoices(ctx)).toEqual({kind:'unavailable'});await expect(readClaimModuleActionDraft(ctx,{employmentId:subject.employmentId,draftId:saved.id})).rejects.toThrow();
});
it('absent and unknown actual browser cookies cannot use DEV_USER_ID or prepare/execute a draft',async()=>{
 vi.stubEnv('DEV_USER_ID',ctx.userId!);const before=await state();for(const selected of [undefined,randomUUID()]){browser.selected=selected;const result=await handleConfiguredModuleActionBrowserCommand(request({action:OWN_CLAIM_DRAFT_ACTION,operation:'prepare',input:human}));expect(result.status).toBe(401);expect(await result.json()).toEqual({error:'unavailable'});}expect(await state()).toEqual(before);expect((await listClaimModuleActionReviews(ctx)).reviews).toHaveLength(0);
});
it('strict browser prepare/confirm/reopen saves exactly one NEW native draft/event without submission and retains current real receipt IDs on an edit',async()=>{
 const prepared=await handleConfiguredModuleActionBrowserCommand(request({action:OWN_CLAIM_DRAFT_ACTION,operation:'prepare',input:human}));expect(prepared.status).toBe(200);const r=(await prepared.json()).review,packet={action:OWN_CLAIM_DRAFT_ACTION,operation:'confirm',confirmation:confirmation(r)},first=await handleConfiguredModuleActionBrowserCommand(request(packet));expect(first.status).toBe(200);const receipt=await first.json();expect(receipt.receipt.semantics).toBe('draft_saved_not_submitted_or_reimbursed');const before=await state();expect(before.claims).toHaveLength(1);expect(before.events).toHaveLength(1);expect(await (await handleConfiguredModuleActionBrowserCommand(request(packet))).json()).toEqual(receipt);expect(await (await handleConfiguredModuleActionBrowserCommand(request({action:OWN_CLAIM_DRAFT_ACTION,operation:'reopen',actionId:r.actionId}))).json()).toEqual(receipt);expect(await state()).toEqual(before);
 const attachment=await addClaimAttachment(ctx,{claimRequestId:receipt.receipt.draftId,fileName:'fictional.pdf',mimeType:'application/pdf',content:Buffer.from('%PDF-1.4 fictional receipt')}),edit=await readClaimModuleActionDraft(ctx,{employmentId:subject.employmentId,draftId:receipt.receipt.draftId});expect(edit.draft.receipts.map(row=>row.id)).toEqual([attachment.id]);expect(JSON.stringify(edit)).not.toContain('%PDF');const update=await prepare(ctx,{...human,draftId:receipt.receipt.draftId,expectedDraftRevision:edit.draft.draftRevision,retainedAttachmentIds:[attachment.id],enteredAmount:30});await confirm(update);expect((await state()).claims[0].status).toBe('draft');const attachments=await owner.db.select().from(s.claimAttachment).where(eq(s.claimAttachment.claimRequestId,receipt.receipt.draftId));expect(attachments).toHaveLength(1);expect(attachments[0].id).toBe(attachment.id);
});
it('expired review and current Claims revocation refuse a browser effect without changing native rows',async()=>{
 const r=await prepare();await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '12 minutes',expires_at=clock_timestamp()-interval '1 minute' where id=${r.actionId}::uuid`);const before=await state();const response=await handleConfiguredModuleActionBrowserCommand(request({action:OWN_CLAIM_DRAFT_ACTION,operation:'confirm',confirmation:confirmation(r)}));expect(response.status).toBe(200);expect(await response.json()).toMatchObject({kind:'retired',receipt:{state:'expired'}});expect(await state()).toEqual(before);await setModule(b.tenantId,'claims','disabled');expect(await readClaimModuleActionChoices(ctx)).toEqual({kind:'unavailable'});expect(await state()).toEqual(before);
});
