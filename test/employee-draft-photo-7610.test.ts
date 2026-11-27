/** Board 2c1b2fba — the Draft Employee page's profile photo (migration 7610, db/migrations/7610_employee_draft_photo.sql;
 * core/employee-draft-photo.ts; app/admin/personnel/new/actions.ts uploadDraftPhotoAction / removeDraftPhotoAction).
 *
 * ADR 0181 evidence on the fictional 71-company / 1,000-employment group fixture (buildScaleFixture,
 * test/helpers/ai-centre-scale-fixture.ts), with one draft per company and a photo on every one (seeded as the storage
 * owner: their content is what is timed, not their writer):
 *  - ACCESS-RULE TIMING. OLD RULE TEXT: none. 7610 creates a new table with one new policy (visible and writable
 *    exactly where its draft is: tenant + EXISTS over employee_draft under the caller's own row security) and changes no
 *    existing table, policy or function, so the new text is timed alone and held to absolute bounds. The product's own
 *    statements are captured with observeStatements and replayed with explain (analyze, buffers, format json) in the
 *    application role under the persona's own identity statement, in a transaction that is rolled back: the photo read
 *    (getEmployeeDraftPhoto) and the upsert (setEmployeeDraftPhoto), for the group administrator and a company-scoped
 *    administrator. Every plan is printed as one `POLICY_TIMING_7610 {json}` line.
 *  - READ BUDGETS. Both server actions are called as the browser calls them (the real module; the session mocked at the
 *    Next.js edge only) and counted with observeStatements against the recorded BUDGETS; "All companies" (the group
 *    administrator, and an administrator granted all 71 companies one by one) must cost no more than one company (no
 *    per-company loop). Every measurement is printed as one `ACTION_BUDGET_7610 {json}` line.
 *  - BEHAVIOUR. Upload, replace, the refusals (type, size, empty), company scope, tenant isolation, remove, discard
 *    (cascade) and activation (moved onto the person through the canonical owner; person.photo.set with no PII).
 * All names are invented. */
import {randomUUID} from 'node:crypto';
import {and,asc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({session:undefined as unknown,cookies:{} as Record<string,string>}));
vi.mock('next/headers',()=>({
 headers:async()=>new Headers(),
 cookies:async()=>({get:(name:string)=>name in state.cookies?{name,value:state.cookies[name]}:undefined,
  getAll:()=>Object.entries(state.cookies).map(([name,value])=>({name,value})),has:(name:string)=>name in state.cookies}),
}));
vi.mock('next/cache',async importOriginal=>({...await importOriginal<typeof import('next/cache')>(),revalidatePath:vi.fn(),revalidateTag:vi.fn()}));
vi.mock('next/navigation',async importOriginal=>({...await importOriginal<typeof import('next/navigation')>(),
 redirect:vi.fn((url:string)=>{throw Object.assign(new Error(`NEXT_REDIRECT ${url}`),{digest:`NEXT_REDIRECT;replace;${url}`});})}));
vi.mock('../lib/session',async importOriginal=>({...await importOriginal<typeof import('../lib/session')>(),
 getSession:async()=>state.session,getBrowserCommandSession:async()=>state.session}));

import {client,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {removeDraftPhotoAction,uploadDraftPhotoAction} from '../app/admin/personnel/new/actions';
import {DraftPhotoError,getEmployeeDraftPhoto,setEmployeeDraftPhoto} from '../core/employee-draft-photo';
import {completeEmployeeDraft,createEmployeeDraftWithReservedCode,discardEmployeeDraft,saveEmployeeDraft} from '../core/employee-draft';
import {createConfig} from '../core/employee-id-config';
import {PHOTO_MAX_BYTES} from '../lib/profile-photo-limits';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {isIdentityStatement,observeStatements,type Captured} from './helpers/statement-observer';

/** Ceilings per statement kind (ms on the CI runner, EXPLAIN ANALYZE overhead included; shared buffers of the whole
 * statement, the policy's EXISTS over employee_draft and its access functions included). FIRST ESTIMATES, not yet
 * measured: generous but finite, to be tightened from the first alpha-focused-checks run's POLICY_TIMING_7610 lines. */
const PLAN_LIMITS={
 read:{executionMs:200,planningMs:300,buffers:5000},
 upsert:{executionMs:400,planningMs:400,buffers:10000},
} as const;
type Kind=keyof typeof PLAN_LIMITS;

type Action='uploadDraftPhotoAction'|'removeDraftPhotoAction';
/** Recorded budgets per action: the largest (transactions, statements) measured over every persona below. FIRST
 * ESTIMATES, not yet measured: each action is one transaction by construction (core/employee-draft-photo.ts), and the
 * statement ceilings are generous; tighten both from the first CI run's ACTION_BUDGET_7610 lines. Budgets only go
 * down; raising one needs an ADR note (docs/adr/0181-database-read-cost-architecture.md). */
const BUDGETS:Record<Action,{transactions:number;statements:number}>={
 uploadDraftPhotoAction:{transactions:2,statements:30},
 removeDraftPhotoAction:{transactions:2,statements:30},
};

/** Scale-fixture cases. No CI duration measured yet (first run): 120 s is a generous first ceiling (rule 15), to be set
 * to about 3× the measured duration after the run. */
const CASE_TIMEOUT=120_000;

const PNG_SIGNATURE=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const png=(fill:number,n=64)=>Buffer.concat([PNG_SIGNATURE,Buffer.alloc(n,fill)]);
const jpeg=(fill:number,n=80)=>Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.alloc(n,fill)]);

let b:Base,fixture:ScaleFixture,a:SessionContext,companyId:string;
/** One owner-seeded draft per company of the fixture (71), each with a photo; `ownDraft` is the company-scoped
 * administrator's company's draft, `foreignDraft` the group company's. */
let drafts:{id:string;companyId:string}[]=[],ownDraft:string,foreignDraft:string;
const measured:Record<string,{transactions:number;statements:number}>={};

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 fixture=await buildScaleFixture(b,{employments:1000,events:2000});
 a=adminCtx(b);companyId=fixture.singleCompanyId;
 drafts=await owner.db.insert(schema.employeeDraft).values(fixture.companyIds.map((id,i)=>({tenantId:b.tenantId,companyId:id,label:`Fictional Draft ${i}`,
  data:{profile:{fullName:`Fictional Draft ${i}`},employment:{companyId:id}},currentStep:1}))).returning({id:schema.employeeDraft.id,companyId:schema.employeeDraft.companyId}) as {id:string;companyId:string}[];
 await owner.db.insert(schema.employeeDraftPhoto).values(drafts.map((d,i)=>{const content=png(i%200);
  return {tenantId:b.tenantId,draftId:d.id,content,fileName:`fictional-${i}.png`,mimeType:'image/png',sizeBytes:content.byteLength};}));
 ownDraft=drafts.find(d=>d.companyId===companyId)!.id;
 foreignDraft=drafts.find(d=>d.companyId===b.companyId)!.id;
 await owner.client.unsafe('analyze public.employee_draft, public.employee_draft_photo');
},300_000);
afterAll(async()=>{console.log('ACTION_BUDGET_7610_SUMMARY '+JSON.stringify(measured));await closeAll();});

const storedPhoto=async(draftId:string)=>(await owner.db.select({content:schema.employeeDraftPhoto.content,mimeType:schema.employeeDraftPhoto.mimeType,
 fileName:schema.employeeDraftPhoto.fileName,sizeBytes:schema.employeeDraftPhoto.sizeBytes}).from(schema.employeeDraftPhoto).where(eq(schema.employeeDraftPhoto.draftId,draftId)))[0]??null;
const bytesOf=(content:unknown)=>Buffer.from(content as Uint8Array);

// ── Access-rule timing ─────────────────────────────────────────────────────────────────────────────────────────
type PlanNode={'Node Type':string;'Relation Name'?:string;'Index Name'?:string;'Subplan Name'?:string;
 'Actual Rows'?:number;'Actual Loops'?:number;'Shared Hit Blocks'?:number;'Shared Read Blocks'?:number;Filter?:string;Plans?:PlanNode[]};
type Explained={plan:PlanNode;executionMs:number;planningMs:number;profile:{role:string;bypass:boolean;rowSecurity:string;jit:string}};
const nodes=(n:PlanNode):PlanNode[]=>[n,...(n.Plans??[]).flatMap(nodes)];
const ROLLBACK=new Error('rolled back on purpose');

async function explainRolledBack(identity:Captured,statement:{sql:string;params:readonly unknown[]}):Promise<Explained>{
 let out:Explained|undefined;
 await client.begin(async tx=>{
  await tx.unsafe(identity.sql,identity.params as never[]);
  const [profile]=await tx.unsafe(`select current_user as role,(select rolbypassrls from pg_roles where rolname=current_user) as bypass,
   current_setting('row_security') as "rowSecurity",current_setting('jit') as jit`) as unknown as Explained['profile'][];
  const rows=await tx.unsafe(`explain (analyze, buffers, format json) ${statement.sql}`,statement.params as never[]);
  const plan=(rows[0] as Record<string,unknown>)['QUERY PLAN'] as [{Plan:PlanNode;'Execution Time':number;'Planning Time':number}];
  out={plan:plan[0].Plan,executionMs:plan[0]['Execution Time'],planningMs:plan[0]['Planning Time'],profile};
  throw ROLLBACK;
 }).catch(error=>{if(error!==ROLLBACK)throw error;});
 return out!;
}
function statementOf(observed:{statements:Captured[]},match:RegExp):{identity:Captured;statement:Captured}{
 const index=observed.statements.findIndex(s=>match.test(s.sql));
 expect(index,`a statement matching ${match}`).toBeGreaterThan(0);
 const identity=[...observed.statements.slice(0,index)].reverse().find(s=>isIdentityStatement(s.sql));
 expect(identity,'its identity statement').toBeTruthy();
 return {identity:identity!,statement:observed.statements[index]};
}
function expectBounded(kind:Kind,label:string,explained:Explained,stored:number){
 expect(explained.profile,`${label} runs as the application role under row security`).toEqual({role:'ai_hr_app',bypass:false,rowSecurity:'on',jit:'off'});
 const all=nodes(explained.plan);
 const policyNodes=all.filter(n=>n['Relation Name']==='employee_draft_photo'||n['Relation Name']==='employee_draft');
 const maxLoops=Math.max(0,...policyNodes.map(n=>n['Actual Loops']??0));
 const buffers=(explained.plan['Shared Hit Blocks']??0)+(explained.plan['Shared Read Blocks']??0);
 console.log('POLICY_TIMING_7610 '+JSON.stringify({kind,label,executionMs:Math.round(explained.executionMs*100)/100,planningMs:Math.round(explained.planningMs*100)/100,buffers,maxPolicyNodeLoops:maxLoops,stored,
  nodes:all.map(n=>({node:n['Node Type'],relation:n['Relation Name']??n['Index Name']??null,subplan:n['Subplan Name']??null,rows:n['Actual Rows']??0,loops:n['Actual Loops']??0,filter:n.Filter?n.Filter.slice(0,200):null}))}));
 expect(policyNodes.length,`${label}: the plan reads employee_draft_photo or employee_draft`).toBeGreaterThan(0);
 expect(maxLoops,`${label}: a node over employee_draft_photo / employee_draft loops at most once per stored row`).toBeLessThanOrEqual(Math.max(stored,1));
 expect(explained.executionMs,`${label}: execution ms`).toBeLessThanOrEqual(PLAN_LIMITS[kind].executionMs);
 expect(explained.planningMs,`${label}: planning ms`).toBeLessThanOrEqual(PLAN_LIMITS[kind].planningMs);
 expect(buffers,`${label}: shared buffers`).toBeLessThanOrEqual(PLAN_LIMITS[kind].buffers);
}

describe('7610 employee_draft_photo rule at group scale (71 companies, 1,000 employments, 71 drafts with photos)',()=>{
 it('the photo read and the upsert are bounded for a group and a company-scoped administrator',async()=>{
  expect(drafts.length).toBe(71);
  const personas:[string,SessionContext][]=[['group administrator',fixture.personas.group],['company-scoped administrator',fixture.personas.single]];
  for(const [label,ctx] of personas){
   // The read: the product's statement, one row (non-vacuous), bounded.
   const read=await observeStatements(()=>getEmployeeDraftPhoto(ctx,ownDraft));
   expect(read.result,label).not.toBeNull();
   expect(read.result!.mimeType,label).toMatch(/^image\/(png|jpeg)$/);
   const r=statementOf(read,/from "employee_draft_photo"/i);
   const readPlan=await explainRolledBack(r.identity,r.statement);
   expect(readPlan.plan['Actual Rows'],`${label}: the read returns the one photo`).toBe(1);
   expectBounded('read',`read | ${label}`,readPlan,drafts.length);
   // The upsert: the product's statement (a replace, so ON CONFLICT DO UPDATE runs), then replayed rolled back.
   const content=jpeg(label.length);
   const upsert=await observeStatements(()=>setEmployeeDraftPhoto(ctx,{draftId:ownDraft,content,fileName:'fictional.jpg',mimeType:'image/jpeg',sizeBytes:content.byteLength}));
   expect(bytesOf((await storedPhoto(ownDraft))!.content).equals(content),label).toBe(true);
   const u=statementOf(upsert,/insert into "employee_draft_photo"/i);
   const upsertPlan=await explainRolledBack(u.identity,u.statement);
   expectBounded('upsert',`upsert | ${label}`,upsertPlan,drafts.length);
   // The rolled-back replay left the committed photo as it was.
   expect(bytesOf((await storedPhoto(ownDraft))!.content).equals(content),label).toBe(true);
  }
  // Non-vacuous refusals under the same rule: the company-scoped administrator sees no other company's draft photo,
  // and the rule refuses a direct write for it.
  expect(await getEmployeeDraftPhoto(fixture.personas.single,foreignDraft)).toBeNull();
  const before=await storedPhoto(foreignDraft);
  await expect(setEmployeeDraftPhoto(fixture.personas.single,{draftId:foreignDraft,content:png(9),fileName:'x.png',mimeType:'image/png',sizeBytes:png(9).byteLength}))
   .rejects.toSatisfy((e:unknown)=>e instanceof DraftPhotoError&&(e.reason==='unavailable'||e.reason==='permission'));
  expect(bytesOf((await storedPhoto(foreignDraft))!.content).equals(bytesOf(before!.content))).toBe(true);
 },CASE_TIMEOUT);
});

// ── Read budgets of the two server actions ─────────────────────────────────────────────────────────────────────
type Persona='group'|'multi'|'single';
const personaCtx=(persona:Persona):SessionContext=>({...fixture.personas[persona]});
const form=(draftId:string,file:File|string|null)=>{const f=new FormData();f.set('draftId',draftId);if(file!==null)f.set('file',file);return f;};
const fileOf=(content:Buffer,name:string,type:string)=>new File([new Uint8Array(content)],name,{type});

async function measure<T>(action:Action,label:string,persona:Persona,work:()=>Promise<T>){
 // A fresh session object for every call, so nothing is reused from an earlier measurement by identity.
 state.session=personaCtx(persona);state.cookies={};
 const observed=await observeStatements(work);
 const row={action,label,persona,transactions:observed.transactions,statements:observed.statements.length,ms:Math.round(observed.ms)};
 console.log('ACTION_BUDGET_7610 '+JSON.stringify(row));
 const key=`${action}|${label}|${persona}`;
 measured[key]={transactions:row.transactions,statements:row.statements};
 return {...observed,key};
}
function expectWithinBudget(action:Action,observed:{transactions:number;statements:unknown[];key:string}){
 expect(observed.transactions,`${observed.key} transactions`).toBeGreaterThan(0);
 expect(observed.transactions,`${observed.key} transactions`).toBeLessThanOrEqual(BUDGETS[action].transactions);
 expect(observed.statements.length,`${observed.key} statements`).toBeLessThanOrEqual(BUDGETS[action].statements);
}
/** No per-company or per-row loop: the wider measurement costs no more than the narrower one. */
function expectNoWiderCost(wide:{transactions:number;statements:unknown[];key:string},narrow:{transactions:number;statements:unknown[];key:string}){
 expect(wide.transactions,`${wide.key} vs ${narrow.key} transactions`).toBeLessThanOrEqual(narrow.transactions);
 expect(wide.statements.length,`${wide.key} vs ${narrow.key} statements`).toBeLessThanOrEqual(narrow.statements.length);
}

describe('board 2c1b2fba: the draft photo actions at group scale',()=>{
 it('upload, replace and remove in a bounded number of reads for every scope, with no per-company cost',async()=>{
  // One unmeasured call first: process-level caches (tenant facts the first transaction learns) fill once.
  state.session=personaCtx('group');state.cookies={};
  expect(await uploadDraftPhotoAction(form(ownDraft,fileOf(png(1),'warm.png','image/png')))).toEqual({ok:true});
  const uploads:Record<string,Awaited<ReturnType<typeof measure>>>={},removes:Record<string,Awaited<ReturnType<typeof measure>>>={};
  for(const persona of ['group','multi','single'] as const){
   // Upload a PNG (over the existing photo: the upsert path), read the bytes back independently.
   const first=png(persona.length+20);
   uploads[persona]=await measure('uploadDraftPhotoAction','upload',persona,()=>uploadDraftPhotoAction(form(ownDraft,fileOf(first,'fictional.png','image/png'))));
   expect(uploads[persona].result,uploads[persona].key).toEqual({ok:true});
   expect(await storedPhoto(ownDraft)).toMatchObject({mimeType:'image/png',fileName:'fictional.png',sizeBytes:first.byteLength});
   expect(bytesOf((await storedPhoto(ownDraft))!.content).equals(first)).toBe(true);
   expectWithinBudget('uploadDraftPhotoAction',uploads[persona]);
   // Replace it with a JPEG: one row, the new bytes.
   const second=jpeg(persona.length+40);
   state.session=personaCtx(persona);
   expect(await uploadDraftPhotoAction(form(ownDraft,fileOf(second,'fictional.jpg','image/jpeg')))).toEqual({ok:true});
   expect(await storedPhoto(ownDraft)).toMatchObject({mimeType:'image/jpeg',fileName:'fictional.jpg',sizeBytes:second.byteLength});
   expect(bytesOf((await storedPhoto(ownDraft))!.content).equals(second)).toBe(true);
   expect(await owner.db.select({id:schema.employeeDraftPhoto.id}).from(schema.employeeDraftPhoto).where(eq(schema.employeeDraftPhoto.draftId,ownDraft))).toHaveLength(1);
   // Remove it.
   removes[persona]=await measure('removeDraftPhotoAction','remove',persona,()=>removeDraftPhotoAction(ownDraft));
   expect(removes[persona].result,removes[persona].key).toEqual({ok:true});
   expect(await storedPhoto(ownDraft)).toBeNull();
   expectWithinBudget('removeDraftPhotoAction',removes[persona]);
   // Put a photo back for the next persona's upsert path.
   state.session=personaCtx(persona);
   expect(await uploadDraftPhotoAction(form(ownDraft,fileOf(png(3),'back.png','image/png')))).toEqual({ok:true});
  }
  for(const set of [uploads,removes]){
   // 71 companies (group-wide grant) against one company's grant, and 71 company-by-company grants against one.
   expectNoWiderCost(set.group,set.single);
   expectNoWiderCost(set.multi,set.single);
  }
  // The audit trail names the type and size only: never the bytes or the file name.
  const events=await owner.db.select({eventType:schema.domainEvent.eventType,payload:schema.domainEvent.payload}).from(schema.domainEvent)
   .where(and(eq(schema.domainEvent.aggregateId,ownDraft),sql`${schema.domainEvent.eventType} like 'employee-draft.photo.%'`)).orderBy(asc(schema.domainEvent.occurredAt));
  expect(events.length).toBeGreaterThan(0);
  for(const e of events){
   expect(Object.keys(e.payload as object).sort(),e.eventType).toEqual(e.eventType==='employee-draft.photo.set'?['companyId','mimeType','sizeBytes']:['companyId']);
   expect(JSON.stringify(e.payload)).not.toMatch(/fictional|back\.png|warm\.png/);
  }
 },CASE_TIMEOUT);

 it('refuses another type, an oversized and an empty file, another company and another tenant, and changes nothing',async()=>{
  state.session=personaCtx('group');
  const kept=png(42);
  expect(await uploadDraftPhotoAction(form(ownDraft,fileOf(kept,'kept.png','image/png')))).toEqual({ok:true});
  const unchanged=async()=>{const row=await storedPhoto(ownDraft);expect(row).toMatchObject({mimeType:'image/png',fileName:'kept.png'});expect(bytesOf(row!.content).equals(kept)).toBe(true);};
  // Type: sniffed from the bytes, whatever the browser claims.
  const refusals:[string,FormData,string][]=[
   ['a GIF',form(ownDraft,fileOf(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;','latin1'),'x.gif','image/gif')),'type'],
   ['an SVG claiming PNG',form(ownDraft,fileOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),'x.png','image/png')),'type'],
   ['a text file',form(ownDraft,fileOf(Buffer.from('not a photo'),'x.txt','text/plain')),'type'],
   ['an oversized PNG',form(ownDraft,fileOf(png(5,PHOTO_MAX_BYTES),'big.png','image/png')),'too_large'],
   ['an empty file',form(ownDraft,fileOf(Buffer.alloc(0),'empty.png','image/png')),'invalid'],
   ['no file',form(ownDraft,null),'invalid'],
   ['a string instead of a file',form(ownDraft,'not-a-file'),'invalid'],
  ];
  for(const [label,body,error] of refusals){
   state.session=personaCtx('group');
   expect(await uploadDraftPhotoAction(body),label).toEqual({ok:false,error});
   await unchanged();
  }
  // A draft id that is not one: unavailable, nothing written.
  expect(await uploadDraftPhotoAction(form('not-a-uuid',fileOf(png(1),'x.png','image/png')))).toEqual({ok:false,error:'unavailable'});
  expect(await uploadDraftPhotoAction(form(randomUUID(),fileOf(png(1),'x.png','image/png')))).toEqual({ok:false,error:'unavailable'});

  // A company-scoped administrator of ANOTHER company: refused, and the other company's photo is untouched.
  const foreignBefore=await storedPhoto(foreignDraft);
  state.session=personaCtx('single');
  const up=await uploadDraftPhotoAction(form(foreignDraft,fileOf(png(77),'intruder.png','image/png')));
  expect(up.ok).toBe(false);expect(['permission','unavailable']).toContain((up as {error:string}).error);
  state.session=personaCtx('single');
  const rm=await removeDraftPhotoAction(foreignDraft);
  expect(rm.ok).toBe(false);expect(['permission','unavailable']).toContain((rm as {error:string}).error);
  expect(bytesOf((await storedPhoto(foreignDraft))!.content).equals(bytesOf(foreignBefore!.content))).toBe(true);
  expect(await getEmployeeDraftPhoto(fixture.personas.single,foreignDraft)).toBeNull();

  // Another tenant: cannot see, write or remove this tenant's draft photo.
  const other=await seedBase();const otherCtx=adminCtx(other);
  expect(await getEmployeeDraftPhoto(otherCtx,ownDraft)).toBeNull();
  state.session={...otherCtx};
  expect(await uploadDraftPhotoAction(form(ownDraft,fileOf(png(88),'tenant.png','image/png')))).toEqual({ok:false,error:'unavailable'});
  state.session={...otherCtx};
  expect(await removeDraftPhotoAction(ownDraft)).toEqual({ok:false,error:'unavailable'});
  await unchanged();
  expect(await owner.db.select({id:schema.employeeDraftPhoto.id}).from(schema.employeeDraftPhoto).where(eq(schema.employeeDraftPhoto.tenantId,other.tenantId))).toEqual([]);

  // A session that is not an administrator is sent away before anything is read.
  state.session={...personaCtx('group'),roles:['employee']};
  await expect(uploadDraftPhotoAction(form(ownDraft,fileOf(png(1),'x.png','image/png')))).rejects.toThrow(/NEXT_REDIRECT/);
  await unchanged();
 },CASE_TIMEOUT);

 it('discard removes the draft photo by cascade; activation moves it onto the person (person.photo.set, no PII)',async()=>{
  await createConfig(a,{companyId:b.companyId,prefix:'PHO',startNumber:1,numberLength:5,increment:1,allowManualOverride:true});
  const held=async(name:string)=>{
   const created=await createEmployeeDraftWithReservedCode(a,{companyId:b.companyId,fullName:name,primaryEmail:`photo.${randomUUID().slice(0,8)}@fixture.test`});
   const [row]=await owner.db.select({data:schema.employeeDraft.data}).from(schema.employeeDraft).where(eq(schema.employeeDraft.id,created.id));
   const data=row.data as {profile?:Record<string,string>;employment?:Record<string,string>};
   await saveEmployeeDraft(a,{id:created.id,currentStep:1,data:{...data,profile:{...data.profile},
    employment:{...data.employment,companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-03-01'},
    payroll:{basicSalary:'3000',paymentMethod:'cash'}}});
   return created;
  };
  // Discard: the draft row goes, and its photo with it (ON DELETE CASCADE).
  const discarded=await held('Fictional Discarded Photo');
  state.session=personaCtx('group');
  expect(await uploadDraftPhotoAction(form(discarded.id,fileOf(png(11),'discard.png','image/png')))).toEqual({ok:true});
  expect(await storedPhoto(discarded.id)).not.toBeNull();
  await discardEmployeeDraft(a,discarded.id);
  expect(await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id,discarded.id))).toEqual([]);
  expect(await storedPhoto(discarded.id)).toBeNull();

  // Activation: the photo lands on the new person through the canonical owner and the draft photo is gone.
  const activated=await held('Fictional Activated Photo');
  const photo=jpeg(23,120);
  state.session=personaCtx('group');
  expect(await uploadDraftPhotoAction(form(activated.id,fileOf(photo,'Fictional Activated Photo.jpg','image/jpeg')))).toEqual({ok:true});
  const {employmentId}=await completeEmployeeDraft(a,activated.id);
  const [emp]=await owner.db.select({personId:schema.employment.personId,employeeCode:schema.employment.employeeCode}).from(schema.employment).where(eq(schema.employment.id,employmentId));
  expect(emp.employeeCode).toBe(activated.employeeCode);
  const [onPerson]=await owner.db.select().from(schema.personPhoto).where(eq(schema.personPhoto.personId,emp.personId));
  expect(onPerson).toMatchObject({tenantId:b.tenantId,mimeType:'image/jpeg',sizeBytes:photo.byteLength,fileName:'Fictional Activated Photo.jpg'});
  expect(bytesOf(onPerson.content).equals(photo)).toBe(true);
  expect(await storedPhoto(activated.id)).toBeNull();
  expect(await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id,activated.id))).toEqual([]);
  const set=await owner.db.select({payload:schema.domainEvent.payload,subject:schema.domainEvent.subjectEmploymentId}).from(schema.domainEvent)
   .where(and(eq(schema.domainEvent.aggregateId,emp.personId),eq(schema.domainEvent.eventType,'person.photo.set')));
  expect(set).toEqual([{payload:{mimeType:'image/jpeg',sizeBytes:photo.byteLength},subject:employmentId}]);
 },CASE_TIMEOUT);
});
