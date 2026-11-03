/** AI v2 Phase 2, P2-6 — what an administrator decides on the AI quality page: dismiss or reopen a correction, make it (or
 * a gap) an eval candidate, edit, approve, withdraw and export the candidate, and set a gap's status.
 *
 * Every decision is an administrator's, under their own login, for a company they administer (./access.ts and the 0972
 * policies), and every one is a new version: a review and a gap status append a row (the latest wins, and an earlier state
 * comes back as a new version); a candidate's every change bumps its version, checked against the version the screen
 * showed so a stale screen cannot overwrite a newer one. Each is audited as a domain event with counts and names only.
 *
 * WORDS. A candidate's question and expectation are the administrator's own, written from the signal's or the gap's facts
 * (closed vocabularies: kind, action, area, role, locale, reason) and fictionalised by them. No words from anyone's chat
 * reach them: gaps keep no examples and corrections show none (AI v2 Phase 2 hardening, ADR-0169 §9). They are redacted
 * again here on every save (./redact.ts, with every name
 * the administrator's row-level security lets them see), and the stored text is what they approve. Only an approved
 * candidate is exported (./export.ts), and exporting replaces each placeholder with a fictional value. Nothing here
 * changes the eval set, a prompt, a calculation, a permission or a disclosure rule. */
import {and,desc,eq,inArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {terasEvalCandidate,terasGapOccurrence,terasGapStatus,terasLearningSignal,terasLearningSignalReview} from '../../db/teras-learning-schema';
import {LearningRefused,captureCtx,requireLearningAdmin} from './access';
import {candidateFileName,exportCandidate as candidateFile} from './export';
import {gapStatusesTx,reviewStatesTx} from './quality';
import {REDACTION_VERSION,looksRedacted,redact} from './redact';
import {knownNamesTx} from './signals';
import {CORRECTION_KINDS,EVAL_FACTORS,EVAL_KINDS,EXPECTATION_MAX_CHARS,GAP_STATUSES,INTENT_KEY,QUESTION_MAX_CHARS,type EvalFactor,type EvalKind} from './types';

export {EXPECTATION_MAX_CHARS,QUESTION_MAX_CHARS,candidateDefaults} from './types';
const guid=z.guid().transform(value=>value.toLowerCase());

/** The company must be this tenant's and the person its administrator (app.is_admin_for answers from the grants alone). */
async function adminForTx(tx:Tx,companyId:string){
 const [row]=await tx.execute(sql`select exists(select 1 from public.company c where c.id=${companyId}::uuid and c.tenant_id=app.current_tenant_id()
  and app.is_admin_for(c.id)) as ok`) as unknown as {ok:boolean|null}[];
 if(row?.ok!==true)throw new LearningRefused('not_administrator');
}
const event=(tx:Tx,ctx:SessionContext,companyId:string,eventType:string,payload:Record<string,unknown>)=>appendEvent(tx,{tenantId:ctx.tenantId,
 aggregateType:'teras-learning',aggregateId:companyId,eventType,actor:actorOf(ctx),payload:{companyId,...payload}});

/** A correction the viewer may review (one of their companies' correction signals), or not found. */
async function signalTx(tx:Tx,ctx:SessionContext,signalId:string){
 const s=terasLearningSignal;
 const [row]=await tx.select().from(s).where(and(eq(s.tenantId,ctx.tenantId),eq(s.id,signalId))).limit(1);
 if(!row||!(CORRECTION_KINDS as readonly string[]).includes(row.kind))throw new LearningRefused('not_found');
 await adminForTx(tx,row.companyId);
 return row;
}
async function reviewTx(tx:Tx,ctx:SessionContext,signal:Readonly<{id:string;companyId:string}>,decision:'dismissed'|'reopened'|'promoted'){
 const current=(await reviewStatesTx(tx,ctx,[signal.id])).get(signal.id);
 const allowed=decision==='reopened'?current?.decision==='dismissed':current===undefined||current.decision==='reopened';
 if(!allowed)throw new LearningRefused('state');
 const version=(current?.version??0)+1;
 await tx.insert(terasLearningSignalReview).values({tenantId:ctx.tenantId,companyId:signal.companyId,signalId:signal.id,decision,version,byUserId:ctx.userId!});
 await event(tx,ctx,signal.companyId,'teras-learning.signal-reviewed',{signalId:signal.id,decision,version});
 return version;
}

const SignalInput=z.object({signalId:guid}).strict();
/** Dismiss an open correction: it leaves the list. Reopen a dismissed one: it comes back. Both are new versions. */
export async function reviewSignal(supplied:SessionContext,input:unknown,decision:'dismissed'|'reopened'){
 const ctx=captureCtx(supplied);requireLearningAdmin(ctx);
 const parsed=SignalInput.safeParse(input);if(!parsed.success)throw new LearningRefused('invalid');
 return withTenant(ctx,async tx=>{const signal=await signalTx(tx,ctx,parsed.data.signalId);return Object.freeze({version:await reviewTx(tx,ctx,signal,decision)});});
}

const Text=(max:number)=>z.string().transform(value=>value.replace(/\s+/g,' ').trim()).pipe(z.string().min(1).max(max*2));
const CandidateText=z.object({question:Text(QUESTION_MAX_CHARS),expectation:Text(EXPECTATION_MAX_CHARS),kind:z.enum(EVAL_KINDS),factor:z.enum(EVAL_FACTORS)}).strict();
type CandidateText=z.infer<typeof CandidateText>;
/** The redacted text, or a refusal when anything a redaction replaces survived (it never should). */
async function redactedTx(tx:Tx,text:CandidateText){
 const names=await knownNamesTx(tx);
 const question=redact(text.question,{knownNames:names,maxLength:QUESTION_MAX_CHARS}).text,expectation=redact(text.expectation,{knownNames:names,maxLength:EXPECTATION_MAX_CHARS}).text;
 if(!question||!expectation||!looksRedacted(question)||!looksRedacted(expectation))throw new LearningRefused('not_redacted');
 return {question,expectation,kind:text.kind as EvalKind,factor:text.factor as EvalFactor};
}

const PromoteSignal=CandidateText.extend({signalId:guid}).strict();
/** Make an open correction an eval candidate: a draft, with the signal's role and locale, and the signal marked promoted. */
export async function promoteSignal(supplied:SessionContext,input:unknown){
 const ctx=captureCtx(supplied);requireLearningAdmin(ctx);
 const parsed=PromoteSignal.safeParse(input);if(!parsed.success)throw new LearningRefused('invalid');
 return withTenant(ctx,async tx=>{
  const signal=await signalTx(tx,ctx,parsed.data.signalId);
  const text=await redactedTx(tx,parsed.data);
  await reviewTx(tx,ctx,signal,'promoted');
  const [row]=await tx.insert(terasEvalCandidate).values({tenantId:ctx.tenantId,companyId:signal.companyId,signalId:signal.id,intentKey:null,role:signal.role,
   locale:signal.locale,...text,redactionVersion:REDACTION_VERSION,createdByUserId:ctx.userId!,changedByUserId:ctx.userId!}).returning({id:terasEvalCandidate.id,version:terasEvalCandidate.version});
  await event(tx,ctx,signal.companyId,'teras-learning.candidate-created',{candidateId:row.id,from:'signal',signalKind:signal.kind,role:signal.role,locale:signal.locale});
  return Object.freeze(row);
 });
}

const PromoteGap=CandidateText.extend({companyId:guid,intentKey:z.string().regex(INTENT_KEY)}).strict();
/** Make a gap intent an eval candidate: a draft with the most common role and locale of its questions in that company. */
export async function promoteGap(supplied:SessionContext,input:unknown){
 const ctx=captureCtx(supplied);requireLearningAdmin(ctx);
 const parsed=PromoteGap.safeParse(input);if(!parsed.success)throw new LearningRefused('invalid');
 const {companyId,intentKey}=parsed.data;
 return withTenant(ctx,async tx=>{
  await adminForTx(tx,companyId);
  const o=terasGapOccurrence;
  const rows=await tx.select({role:o.role,locale:o.locale}).from(o).where(and(eq(o.tenantId,ctx.tenantId),eq(o.companyId,companyId),eq(o.intentKey,intentKey)))
   .orderBy(desc(o.at)).limit(200);
  if(!rows.length)throw new LearningRefused('not_found');
  const most=<T extends string>(values:T[])=>[...values.reduce((map,value)=>map.set(value,(map.get(value)??0)+1),new Map<T,number>())].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0][0];
  const text=await redactedTx(tx,parsed.data);
  const role=most(rows.map(row=>row.role)),locale=most(rows.map(row=>row.locale));
  const [row]=await tx.insert(terasEvalCandidate).values({tenantId:ctx.tenantId,companyId,signalId:null,intentKey,role,locale,...text,
   redactionVersion:REDACTION_VERSION,createdByUserId:ctx.userId!,changedByUserId:ctx.userId!}).returning({id:terasEvalCandidate.id,version:terasEvalCandidate.version});
  await event(tx,ctx,companyId,'teras-learning.candidate-created',{candidateId:row.id,from:'gap',intentKey,role,locale});
  return Object.freeze(row);
 });
}

async function candidateTx(tx:Tx,ctx:SessionContext,candidateId:string,version:number){
 const c=terasEvalCandidate;
 const [row]=await tx.select().from(c).where(and(eq(c.tenantId,ctx.tenantId),eq(c.id,candidateId))).for('update').limit(1);
 if(!row)throw new LearningRefused('not_found');
 await adminForTx(tx,row.companyId);
 if(row.version!==version)throw new LearningRefused('changed');
 return row;
}
const Versioned=z.object({candidateId:guid,version:z.number().int().min(1)}).strict();

const EditCandidate=CandidateText.extend({candidateId:guid,version:z.number().int().min(1)}).strict();
/** Edit a draft: redacted again, the next version. */
export async function editCandidate(supplied:SessionContext,input:unknown){
 const ctx=captureCtx(supplied);requireLearningAdmin(ctx);
 const parsed=EditCandidate.safeParse(input);if(!parsed.success)throw new LearningRefused('invalid');
 return withTenant(ctx,async tx=>{
  const row=await candidateTx(tx,ctx,parsed.data.candidateId,parsed.data.version);
  if(row.state!=='draft')throw new LearningRefused('state');
  const text=await redactedTx(tx,parsed.data);
  const [next]=await tx.update(terasEvalCandidate).set({...text,redactionVersion:REDACTION_VERSION,version:row.version+1,changedByUserId:ctx.userId!})
   .where(eq(terasEvalCandidate.id,row.id)).returning({id:terasEvalCandidate.id,version:terasEvalCandidate.version});
  await event(tx,ctx,row.companyId,'teras-learning.candidate-edited',{candidateId:row.id,version:next.version});
  return Object.freeze(next);
 });
}

type Transition='approve'|'reopen'|'withdraw';
/** approve: draft -> approved (the redacted text as stored is what is approved); reopen: approved -> draft, to edit again;
 * withdraw: draft or approved -> withdrawn (final). */
export async function moveCandidate(supplied:SessionContext,input:unknown,transition:Transition){
 const ctx=captureCtx(supplied);requireLearningAdmin(ctx);
 const parsed=Versioned.safeParse(input);if(!parsed.success)throw new LearningRefused('invalid');
 return withTenant(ctx,async tx=>{
  const row=await candidateTx(tx,ctx,parsed.data.candidateId,parsed.data.version);
  const from=row.state;
  const ok=transition==='approve'?from==='draft':transition==='reopen'?from==='approved':from==='draft'||from==='approved';
  if(!ok)throw new LearningRefused('state');
  if(transition==='approve'&&(!looksRedacted(row.question)||!looksRedacted(row.expectation)))throw new LearningRefused('not_redacted');
  const state=transition==='approve'?'approved' as const:transition==='reopen'?'draft' as const:'withdrawn' as const;
  const [next]=await tx.update(terasEvalCandidate).set({state,version:row.version+1,changedByUserId:ctx.userId!,
   ...(state==='approved'?{approvedByUserId:ctx.userId!}:{approvedByUserId:null,approvedAt:null})})
   .where(eq(terasEvalCandidate.id,row.id)).returning({id:terasEvalCandidate.id,version:terasEvalCandidate.version,state:terasEvalCandidate.state});
  await event(tx,ctx,row.companyId,'teras-learning.candidate-'+(transition==='approve'?'approved':transition==='reopen'?'reopened':'withdrawn'),{candidateId:row.id,version:next.version});
  return Object.freeze(next);
 });
}

export type CandidateExport=Readonly<{fileName:string;text:string}>;
const CandidateId=z.object({candidateId:guid}).strict();
/** Export, step 1 (a server action, so a link cannot do it): an approved candidate becomes exported, the next version.
 * Already exported: nothing changes. A draft or a withdrawn candidate is refused. */
export async function markCandidateExported(supplied:SessionContext,input:unknown){
 const ctx=captureCtx(supplied);requireLearningAdmin(ctx);
 const parsed=CandidateId.safeParse(input);if(!parsed.success)throw new LearningRefused('invalid');
 return withTenant(ctx,async tx=>{
  const c=terasEvalCandidate;
  const [row]=await tx.select().from(c).where(and(eq(c.tenantId,ctx.tenantId),eq(c.id,parsed.data.candidateId))).for('update').limit(1);
  if(!row)throw new LearningRefused('not_found');
  await adminForTx(tx,row.companyId);
  if(row.state==='exported')return Object.freeze({id:row.id,version:row.version});
  if(row.state!=='approved')throw new LearningRefused('state');
  if(!looksRedacted(row.question)||!looksRedacted(row.expectation))throw new LearningRefused('not_redacted');
  await tx.update(c).set({state:'exported',version:row.version+1,changedByUserId:ctx.userId!,exportedByUserId:ctx.userId!}).where(eq(c.id,row.id));
  await event(tx,ctx,row.companyId,'teras-learning.candidate-exported',{candidateId:row.id,version:row.version+1});
  return Object.freeze({id:row.id,version:row.version+1});
 });
}
/** Export, step 2 (the download, read-only): the file of an exported candidate. Anything else is not found. */
export async function candidateExportFile(supplied:SessionContext,input:unknown):Promise<CandidateExport>{
 const ctx=captureCtx(supplied);requireLearningAdmin(ctx);
 const parsed=CandidateId.safeParse(input);if(!parsed.success)throw new LearningRefused('invalid');
 return withTenant(ctx,async tx=>{
  const c=terasEvalCandidate;
  const [row]=await tx.select().from(c).where(and(eq(c.tenantId,ctx.tenantId),eq(c.id,parsed.data.candidateId))).limit(1);
  if(!row||row.state!=='exported')throw new LearningRefused('not_found');
  await adminForTx(tx,row.companyId);
  if(!looksRedacted(row.question)||!looksRedacted(row.expectation))throw new LearningRefused('not_redacted');
  const signalKind=row.signalId?(await tx.select({kind:terasLearningSignal.kind}).from(terasLearningSignal).where(eq(terasLearningSignal.id,row.signalId)).limit(1))[0]?.kind??null:null;
  const approvedOn=(row.approvedAt??row.changedAt).toISOString().slice(0,10);
  return Object.freeze({fileName:candidateFileName(row),text:candidateFile({id:row.id,role:row.role,locale:row.locale,kind:row.kind,factor:row.factor,
   question:row.question,expectation:row.expectation,approvedOn,origin:row.signalId?'signal':'gap',signalKind,intentKey:row.intentKey})});
 });
}

const GapStatusInput=z.object({companyIds:z.array(guid).min(1).max(200),intentKey:z.string().regex(INTENT_KEY),status:z.enum(GAP_STATUSES),
 duplicateOf:z.string().regex(INTENT_KEY).nullable().optional()}).strict()
 .refine(value=>(value.status==='duplicate')===Boolean(value.duplicateOf)&&value.duplicateOf!==value.intentKey);
/** Set an intent's status in each company given (each one the administrator's): open, planned, won't do, or duplicate of
 * another intent. A company already at that status is left alone; every change is the next version there. */
export async function setGapStatus(supplied:SessionContext,input:unknown){
 const ctx=captureCtx(supplied);requireLearningAdmin(ctx);
 const parsed=GapStatusInput.safeParse(input);if(!parsed.success)throw new LearningRefused('invalid');
 const {intentKey,status}=parsed.data,duplicateOf=parsed.data.duplicateOf??null,companyIds=[...new Set(parsed.data.companyIds)];
 return withTenant(ctx,async tx=>{
  for(const companyId of companyIds)await adminForTx(tx,companyId);
  const current=new Map((await gapStatusesTx(tx,ctx,companyIds)).filter(row=>row.intentKey===intentKey).map(row=>[row.companyId,row]));
  const g=terasGapStatus;
  const versions=await tx.select({companyId:g.companyId,version:g.version}).from(g)
   .where(and(eq(g.tenantId,ctx.tenantId),inArray(g.companyId,companyIds),eq(g.intentKey,intentKey))).orderBy(desc(g.version));
  let changed=0;
  for(const companyId of companyIds){
   const before=current.get(companyId);
   if((before?.status??'open')===status&&(before?.duplicateOf??null)===duplicateOf)continue;
   const version=(versions.find(row=>row.companyId===companyId)?.version??0)+1;
   await tx.insert(g).values({tenantId:ctx.tenantId,companyId,intentKey,status,duplicateOf,version,byUserId:ctx.userId!});
   await event(tx,ctx,companyId,'teras-learning.gap-status-set',{intentKey,status,duplicateOf,version,from:before?.status??'open'});
   changed++;
  }
  return Object.freeze({changed});
 });
}
