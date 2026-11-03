/** AI v2 Phase 2, P2-5 — the Living Handbook: policies in the company's own words, the values the system enforces from
 * them, and where the two disagree (migration 2009; AI Centre › Policies, approved mock-up Handbook.dc.html).
 *
 * MODELS PROPOSE, SERVICES ADJUDICATE, PEOPLE CONFIRM.
 *  1. An administrator writes a policy (a draft version: its text, the companies it applies to and the date it applies
 *     from). Administrators of every one of those companies edit it.
 *  2. "Read the values": the model proposes values for settings that already exist in an owner service, each with the
 *     words it came from (./extract.ts adjudicates every proposal). Nothing is applied.
 *  3. A person confirms or rejects each value. A value read from older text no longer counts.
 *  4. "Send for approval" locks the version. Every enforceable setting its text mentions (a value read for it, or a
 *     figure the deterministic read of ./consistency.ts finds) must first be confirmed, or marked "text only, not
 *     enforced" by a person (markTextOnly; recorded and shown). Whether the version changes what the system enforces
 *     is DERIVED by the database from its confirmed values (Phase 2 hardening, 4 November 2026): any confirmed value
 *     makes it a settings change. The sender never states it.
 *  5. A group administrator approves it. A settings change needs a second, different administrator: one who
 *     contributed nothing to it (not its author, an editor, a reader or decider of its values, a text-only marker or a
 *     sender; owner decision 13; the database records every contribution and refuses anything else, migration 2009). A
 *     text-only version needs one approval. Neither is approved while any enforceable figure its text states disagrees
 *     with what the system would then enforce (./consistency.ts; deterministic, no amount worked out). Or they return it.
 *  6. On approval each confirmed value is applied by its owner (./settings.ts), through the owner's own settings write
 *     and validation, under the approving administrator's login, from the version's date (today at the earliest), in ONE
 *     transaction with the application row, so the database guard on that row can roll the owner's write back. An
 *     undated owner setting with a future date waits for that date. Each result is recorded: applied with the owner's
 *     value before and after, refused with the owner's message, or scheduled.
 * Drift (./drift in policiesView) is deterministic: each confirmed value of the version in force against the owner's
 * current setting, and every other enforceable figure its text states (./consistency.ts). "Use the handbook" prepares a
 * draft that applies the handbook's values again; "Update the handbook" prepares a draft whose text says what the
 * system does. Both go through the same confirmation and approval. Any earlier approved version can be made the draft
 * again. Nothing is ever deleted.
 *
 * Isolation: every read and write runs under the caller's own login and row-level security, in their tenant only.
 * Policies apply to companies of one tenant. The three enforceable settings are shared by every company of the tenant,
 * so a value is read, sent and applied only for a version that applies to all of them. Employees read approved text
 * only (./ask.ts answers their questions from the version in force). No amount is worked out here: the impact figures
 * are the claims service's (simulateClaimPolicyImpact). */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {isAdmin,isGroupAdmin} from '../../lib/authz-model';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {simulateClaimPolicyImpact,type ClaimPolicyImpact} from '../../packs/claims/service';
import {adjudicateProposals,bodyDigest,MAX_POLICY_TEXT,settingPrompts,type PolicySpan,type PolicyValueModel,type RejectReason} from './extract';
import {applyOwnerValueTx,availableSettings,claimTypeOf,currentOwnerValue,currentOwnerValueTx,heldSettings,isPolicyArea,isPolicySetting,normalizeBody,ownerMessage,ownerTargets,sameValue,
 UNDATED_SETTINGS,type OwnerTargets,type PolicyArea,type PolicySetting,type SettingBody,type SettingTarget} from './settings';
import {disagreements,figuresOf,mentionedSettings,policyStatements,settingKey,type PolicyDisagreement,type PolicyStatement} from './consistency';

export type PolicyRefusal='not_administrator'|'not_group_admin'|'invalid'|'not_found'|'not_draft'|'not_submitted'|'not_approved'|'undecided'
 |'same_administrator'|'stale_submission'|'shared_setting'|'draft_open'|'no_drift'|'not_due'|'model_unavailable'|'no_settings'|'failed'|'unmarked'|'mismatch';
export class PolicyRefused extends Error{constructor(readonly reason:PolicyRefusal){super('Policy refused: '+reason);this.name='PolicyRefused';}}

const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
const requireAdministrator=(ctx:SessionContext)=>{if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new PolicyRefused('not_administrator');};
const uuid=z.guid();
const isDate=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'));
const rowsOf=<T>(rows:unknown)=>Array.from(rows as Iterable<T>);
const ids=(values:readonly string[])=>sql`array[${sql.join(values.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
const laterOf=(a:string,b:string)=>a>b?a:b;
/** Whether a database error (or one it wraps) is a violation of the named constraint. */
const violates=(error:unknown,constraint:string)=>{for(let cur=error as Record<string,unknown>|undefined,n=0;cur&&typeof cur==='object'&&n<5;cur=cur.cause as never,n++)
 if(cur.constraint_name===constraint||cur.constraint===constraint||(typeof cur.message==='string'&&cur.message.includes(constraint)))return true;return false;};

type VersionRow={id:string;document_id:string;version:number;body:string;effective_from:string;status:'draft'|'submitted'|'approved';origin:string;
 based_on_version_id:string|null;submission:number;changes_settings:boolean|null;author_user_id:string;submitted_by_user_id:string|null;
 submitted_at:Date|null;approved_at:Date|null;created_at:Date;area:PolicyArea;title:string};
type ValueRow={id:string;version_id:string;setting:PolicySetting;target:SettingTarget;value:SettingBody;spans:PolicySpan[];body_digest:string;source:string;decision:'confirmed'|'rejected'|null};

async function versionTx(tx:Tx,ctx:SessionContext,versionId:string,lock=false):Promise<VersionRow>{
 const [row]=rowsOf<VersionRow>(await tx.execute(sql`select v.id,v.document_id,v.version,v.body,to_char(v.effective_from,'YYYY-MM-DD') as effective_from,v.status,v.origin,
  v.based_on_version_id,v.submission,v.changes_settings,v.author_user_id,v.submitted_by_user_id,v.submitted_at,v.approved_at,v.created_at,d.area,d.title
  from public.teras_policy_version v join public.teras_policy_document d on d.id=v.document_id
  where v.id=${versionId}::uuid and v.tenant_id=${ctx.tenantId}::uuid ${lock?sql`for update of v`:sql``}`));
 if(!row)throw new PolicyRefused('not_found');
 return row;
}
async function scopeTx(tx:Tx,ctx:SessionContext,versionId:string):Promise<string[]>{
 return rowsOf<{company_id:string}>(await tx.execute(sql`select company_id from public.teras_policy_scope where version_id=${versionId}::uuid and tenant_id=${ctx.tenantId}::uuid order by company_id`)).map(r=>r.company_id);
}
async function adminAllTx(tx:Tx,versionId:string){
 const [row]=rowsOf<{ok:boolean|null}>(await tx.execute(sql`select app.teras_policy_admin_all(${versionId}::uuid) as ok`));return row?.ok===true;
}
async function adminForEveryTx(tx:Tx,companyIds:readonly string[]){
 if(!companyIds.length)return false;
 const [row]=rowsOf<{ok:boolean|null}>(await tx.execute(sql`select bool_and(app.is_admin_for(c)) as ok from unnest(${ids(companyIds)}) c`));return row?.ok===true;
}
/** Whether the companies are every company of the caller's tenant (companies are readable tenant-wide). */
async function coversTenantTx(tx:Tx,ctx:SessionContext,companyIds:readonly string[]){
 const [row]=rowsOf<{missing:number}>(await tx.execute(sql`select count(*)::int as missing from public.company c where c.tenant_id=${ctx.tenantId}::uuid
  and not (c.id = any(${ids(companyIds.length?companyIds:['00000000-0000-4000-8000-000000000000'])}))`));
 return row?.missing===0;
}
async function companiesValidTx(tx:Tx,ctx:SessionContext,companyIds:readonly string[]){
 const [row]=rowsOf<{n:number}>(await tx.execute(sql`select count(*)::int as n from public.company c where c.tenant_id=${ctx.tenantId}::uuid and c.id = any(${ids(companyIds)})`));
 return row?.n===companyIds.length;
}
/** The current values of a version (read from its current text) with each one's latest decision. */
async function valuesTx(tx:Tx,ctx:SessionContext,version:Pick<VersionRow,'id'|'body'>):Promise<ValueRow[]>{
 return rowsOf<ValueRow>(await tx.execute(sql`select x.id,x.version_id,x.setting,x.target,x.value,x.spans,x.body_digest,x.source,
  (select c.decision from public.teras_policy_value_confirmation c where c.value_id=x.id order by c.decided_at desc,c.id desc limit 1) as decision
  from public.teras_policy_value x where x.version_id=${version.id}::uuid and x.tenant_id=${ctx.tenantId}::uuid and x.body_digest=${bodyDigest(version.body)}
  order by x.proposed_at,x.setting,x.id`));
}
type MarkRow=Readonly<{setting:PolicySetting;marked:boolean;by:string;at:Date}>;
/** The latest text-only mark of each setting of a version's current text. */
async function marksTx(tx:Tx,ctx:SessionContext,version:Pick<VersionRow,'id'|'body'>):Promise<Map<PolicySetting,MarkRow>>{
 const rows=rowsOf<{setting:PolicySetting;marked:boolean;marked_by_user_id:string;marked_at:Date}>(await tx.execute(sql`select distinct on (m.setting) m.setting,m.marked,m.marked_by_user_id,m.marked_at
  from public.teras_policy_text_only m where m.version_id=${version.id}::uuid and m.tenant_id=${ctx.tenantId}::uuid and m.body_digest=${bodyDigest(version.body)}
  order by m.setting,m.marked_at desc,m.id desc`));
 return new Map(rows.map(r=>[r.setting,Object.freeze({setting:r.setting,marked:r.marked,by:r.marked_by_user_id,at:r.marked_at})]));
}
type Consistency=Readonly<{statements:readonly PolicyStatement[];disagreements:readonly PolicyDisagreement[];mentioned:readonly PolicySetting[];uncovered:readonly PolicySetting[]}>;
/** What a version's current text states about enforceable settings, against what the system would enforce: for an
 * unapproved version ('pending') its confirmed values where it has them, the owner's setting otherwise; for the version in
 * force ('in_force') the owner's setting, leaving the confirmed values' own words to value drift. Deterministic. */
async function consistencyOf(ctx:SessionContext,version:Pick<VersionRow,'body'>,values:readonly ValueRow[],marks:ReadonlyMap<PolicySetting,MarkRow>,
 targets:OwnerTargets,asOf:string,mode:'pending'|'in_force'):Promise<Consistency>{
 const stated=values.map(v=>({id:v.id,setting:v.setting,target:v.target,value:normalizeBody(v.setting,v.value)!,spans:v.spans,decision:v.decision}));
 const all=policyStatements(version.body,heldSettings(targets),targets.claimTypes,stated);
 const confirmed=new Map<string,SettingBody>(),extra:PolicyStatement[]=[];
 if(mode==='pending')for(const v of stated.filter(x=>x.decision==='confirmed')){
  const key=settingKey(v.setting,v.target),held=confirmed.get(key);
  if(!held)confirmed.set(key,v.value);
  // Two confirmed values for one setting that differ: the second states what the first will not enforce.
  else if(!sameValue(v.setting,held,v.value))extra.push(Object.freeze({setting:v.setting,target:v.target,figures:Object.freeze(figuresOf(v.setting,v.value)),quote:v.spans.map(s=>s.quote).join(' … '),start:v.spans[0]?.start??0,end:v.spans[0]?.end??0,
   source:'value',valueId:v.id,confirmedWords:true} satisfies PolicyStatement));
 }
 const statements=[...(mode==='in_force'?all.filter(s=>!s.confirmedWords):all),...extra];
 const owner=new Map<string,SettingBody|null>();
 const codes=targets.claimTypes.map(t=>t.code);
 for(const statement of statements){
  const wanted=statement.target?[statement.target]:statement.setting==='claims.submit_within_days'?codes.map(code=>({claimType:code})):[{}];
  for(const target of wanted){const key=settingKey(statement.setting,target);
   if(!confirmed.has(key)&&!owner.has(key))owner.set(key,(await currentOwnerValue(ctx,statement.setting,target,targets,asOf)).value);}
 }
 const found=disagreements(statements,(setting,target)=>{const key=settingKey(setting,target);return confirmed.get(key)??owner.get(key)??null;},codes);
 const mentioned=mentionedSettings(all,stated);
 const uncovered=mentioned.filter(setting=>!stated.some(v=>v.setting===setting&&v.decision==='confirmed')&&marks.get(setting)?.marked!==true);
 return Object.freeze({statements:Object.freeze(statements),disagreements:Object.freeze(found),mentioned:Object.freeze(mentioned),uncovered:Object.freeze(uncovered)});
}
const parseCompanies=(value:unknown):string[]=>{
 const list=Array.isArray(value)?value:[];const out=[...new Set(list.filter((v):v is string=>typeof v==='string'&&uuid.safeParse(v).success))];
 if(!out.length||out.length>200)throw new PolicyRefused('invalid');return out.sort();
};
const parseBody=(value:unknown)=>{if(typeof value!=='string')throw new PolicyRefused('invalid');const body=value.replace(/\r\n/g,'\n').trim();
 if(!body||body.length>MAX_POLICY_TEXT)throw new PolicyRefused('invalid');return body;};
async function event(tx:Tx,ctx:SessionContext,documentId:string,eventType:string,payload:Record<string,unknown>){
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-policy',aggregateId:documentId,eventType,actor:actorOf(ctx),payload});
}
async function insertVersionTx(tx:Tx,ctx:SessionContext,p:{documentId:string;body:string;effectiveFrom:string;origin:string;basedOn:string|null;companyIds:readonly string[]}){
 const [next]=rowsOf<{n:number}>(await tx.execute(sql`select coalesce(max(version),0)+1 as n from public.teras_policy_version where document_id=${p.documentId}::uuid`));
 let row:{id:string}|undefined;
 try{[row]=rowsOf<{id:string}>(await tx.execute(sql`insert into public.teras_policy_version (tenant_id,document_id,version,body,effective_from,origin,based_on_version_id,author_user_id)
  values (${ctx.tenantId}::uuid,${p.documentId}::uuid,${next!.n},${p.body},${p.effectiveFrom}::date,${p.origin},${p.basedOn}::uuid,${ctx.userId}::uuid) returning id`));}
 catch(error){if(violates(error,'teras_policy_version_open_uq'))throw new PolicyRefused('draft_open');throw error;}
 for(const company of p.companyIds)await tx.execute(sql`insert into public.teras_policy_scope (tenant_id,version_id,company_id) values (${ctx.tenantId}::uuid,${row!.id}::uuid,${company}::uuid)`);
 return {id:row!.id,version:next!.n};
}

/** A new policy and its first draft. The administrator must administer every company it applies to. */
export async function createPolicy(supplied:SessionContext,input:Readonly<{area:unknown;title:unknown;body:unknown;effectiveFrom:unknown;companyIds:unknown}>){
 const ctx=capture(supplied);requireAdministrator(ctx);
 const title=typeof input.title==='string'?input.title.trim():'';
 if(!isPolicyArea(input.area)||!title||title.length>160||!isDate(input.effectiveFrom))throw new PolicyRefused('invalid');
 const area=input.area,body=parseBody(input.body),companyIds=parseCompanies(input.companyIds),effectiveFrom=input.effectiveFrom;
 return withTenant(ctx,async tx=>{
  if(!(await companiesValidTx(tx,ctx,companyIds)))throw new PolicyRefused('invalid');
  if(!(await adminForEveryTx(tx,companyIds)))throw new PolicyRefused('not_administrator');
  const [doc]=rowsOf<{id:string}>(await tx.execute(sql`insert into public.teras_policy_document (tenant_id,area,title,created_by_user_id)
   values (${ctx.tenantId}::uuid,${area},${title},${ctx.userId}::uuid) returning id`));
  const version=await insertVersionTx(tx,ctx,{documentId:doc!.id,body,effectiveFrom,origin:'written',basedOn:null,companyIds});
  await event(tx,ctx,doc!.id,'teras-policy.created',{area,versionId:version.id,version:version.version,effectiveFrom,companies:companyIds.length});
  return Object.freeze({documentId:doc!.id,versionId:version.id});
 });
}

/** Edits a draft: its text, date and companies. Values read from the old text stop counting (they stay, for the record). */
export async function saveDraft(supplied:SessionContext,input:Readonly<{versionId:unknown;body:unknown;effectiveFrom:unknown;companyIds:unknown}>){
 const ctx=capture(supplied);requireAdministrator(ctx);
 const versionId=uuid.safeParse(input.versionId);if(!versionId.success||!isDate(input.effectiveFrom))throw new PolicyRefused('invalid');
 const body=parseBody(input.body),companyIds=parseCompanies(input.companyIds),effectiveFrom=input.effectiveFrom;
 return withTenant(ctx,async tx=>{
  const version=await versionTx(tx,ctx,versionId.data,true);
  if(version.status!=='draft')throw new PolicyRefused('not_draft');
  if(!(await adminAllTx(tx,version.id))||!(await companiesValidTx(tx,ctx,companyIds))||!(await adminForEveryTx(tx,companyIds)))throw new PolicyRefused('not_administrator');
  await tx.execute(sql`update public.teras_policy_version set body=${body},effective_from=${effectiveFrom}::date where id=${version.id}::uuid`);
  const before=await scopeTx(tx,ctx,version.id);
  for(const gone of before.filter(c=>!companyIds.includes(c)))await tx.execute(sql`delete from public.teras_policy_scope where version_id=${version.id}::uuid and company_id=${gone}::uuid`);
  for(const added of companyIds.filter(c=>!before.includes(c)))await tx.execute(sql`insert into public.teras_policy_scope (tenant_id,version_id,company_id) values (${ctx.tenantId}::uuid,${version.id}::uuid,${added}::uuid)`);
  await event(tx,ctx,version.document_id,'teras-policy.draft-saved',{versionId:version.id,version:version.version,effectiveFrom,companies:companyIds.length,textChanged:body!==version.body});
  return Object.freeze({versionId:version.id});
 });
}

/** Whether the version can enforce settings: the owners hold some for its area, and it applies to every company. */
async function enforceableTx(tx:Tx,ctx:SessionContext,version:VersionRow,targets:OwnerTargets){
 const settings=availableSettings(version.area,targets);
 return {settings,sharedOk:await coversTenantTx(tx,ctx,await scopeTx(tx,ctx,version.id))};
}

/** "Read the values": the model proposes, ./extract.ts adjudicates, the survivors are stored as proposals. */
export async function readPolicyValues(supplied:SessionContext,input:Readonly<{versionId:unknown}>,model:PolicyValueModel|null){
 const ctx=capture(supplied);requireAdministrator(ctx);
 const versionId=uuid.safeParse(input.versionId);if(!versionId.success)throw new PolicyRefused('invalid');
 const today=todayInKualaLumpur(),targets=await ownerTargets(ctx,today);
 const prepared=await withTenant(ctx,async tx=>{
  const version=await versionTx(tx,ctx,versionId.data);
  if(version.status!=='draft')throw new PolicyRefused('not_draft');
  if(!(await adminAllTx(tx,version.id)))throw new PolicyRefused('not_administrator');
  const {settings,sharedOk}=await enforceableTx(tx,ctx,version,targets);
  if(!settings.length)throw new PolicyRefused('no_settings');
  if(!sharedOk)throw new PolicyRefused('shared_setting');
  return {version,settings};
 });
 if(!model)throw new PolicyRefused('model_unavailable');
 let raw:string;
 try{raw=await model.propose({text:prepared.version.body,settings:settingPrompts(prepared.settings,targets)});}catch{throw new PolicyRefused('model_unavailable');}
 const result=adjudicateProposals(typeof raw==='string'?raw:'',prepared.version.body,prepared.settings,targets);
 return withTenant(ctx,async tx=>{
  const version=await versionTx(tx,ctx,prepared.version.id,true);
  // The text may have changed while the model read it: its proposals would be for words no longer there.
  if(version.status!=='draft'||version.body!==prepared.version.body)throw new PolicyRefused('not_draft');
  const digest=bodyDigest(version.body);
  for(const value of result.accepted)await tx.execute(sql`insert into public.teras_policy_value (tenant_id,version_id,setting,target,value,spans,body_digest,source,proposed_by_user_id)
   values (${ctx.tenantId}::uuid,${version.id}::uuid,${value.setting},${JSON.stringify(value.target)}::jsonb,${JSON.stringify(value.value)}::jsonb,${JSON.stringify(value.spans)}::jsonb,${digest},'model',${ctx.userId}::uuid)`);
  const reasons:Partial<Record<RejectReason,number>>={};for(const row of result.rejected)reasons[row.reason]=(reasons[row.reason]??0)+1;
  await event(tx,ctx,version.document_id,'teras-policy.values-proposed',{versionId:version.id,accepted:result.accepted.length,rejected:reasons,unparseable:result.unparseable,
   settings:result.accepted.map(v=>v.setting)});
  return Object.freeze({accepted:result.accepted.length,rejected:result.rejected.length,unparseable:result.unparseable});
 });
}

/** A person's decision on one value of a draft. */
export async function decidePolicyValue(supplied:SessionContext,input:Readonly<{valueId:unknown;decision:unknown}>){
 const ctx=capture(supplied);requireAdministrator(ctx);
 const valueId=uuid.safeParse(input.valueId);if(!valueId.success||(input.decision!=='confirmed'&&input.decision!=='rejected'))throw new PolicyRefused('invalid');
 const decision=input.decision;
 return withTenant(ctx,async tx=>{
  const [value]=rowsOf<{version_id:string}>(await tx.execute(sql`select version_id from public.teras_policy_value where id=${valueId.data}::uuid and tenant_id=${ctx.tenantId}::uuid`));
  if(!value)throw new PolicyRefused('not_found');
  const version=await versionTx(tx,ctx,value.version_id,true);
  if(version.status!=='draft')throw new PolicyRefused('not_draft');
  if(!(await adminAllTx(tx,version.id)))throw new PolicyRefused('not_administrator');
  if(!(await valuesTx(tx,ctx,version)).some(v=>v.id===valueId.data))throw new PolicyRefused('not_draft');
  await tx.execute(sql`insert into public.teras_policy_value_confirmation (tenant_id,value_id,decision,decided_by_user_id) values (${ctx.tenantId}::uuid,${valueId.data}::uuid,${decision},${ctx.userId}::uuid)`);
  await event(tx,ctx,version.document_id,'teras-policy.value-decided',{versionId:version.id,valueId:valueId.data,decision});
  return Object.freeze({decision});
 });
}

/** "Text only, not enforced": a person's mark (or its withdrawal) that what a draft's current text says about one
 * enforceable setting is not enforced from this policy; the owner's setting stays. Recorded with who and when, shown on
 * the page, and void once the text changes. It never makes a contradiction acceptable: a figure that disagrees with the
 * system still blocks approval (./consistency.ts). */
export async function markTextOnly(supplied:SessionContext,input:Readonly<{versionId:unknown;setting:unknown;marked:unknown}>){
 const ctx=capture(supplied);requireAdministrator(ctx);
 const versionId=uuid.safeParse(input.versionId);
 if(!versionId.success||!isPolicySetting(input.setting)||typeof input.marked!=='boolean')throw new PolicyRefused('invalid');
 const setting=input.setting,marked=input.marked;
 return withTenant(ctx,async tx=>{
  const version=await versionTx(tx,ctx,versionId.data,true);
  if(version.status!=='draft')throw new PolicyRefused('not_draft');
  if(!(await adminAllTx(tx,version.id)))throw new PolicyRefused('not_administrator');
  await tx.execute(sql`insert into public.teras_policy_text_only (tenant_id,version_id,setting,body_digest,marked,marked_by_user_id)
   values (${ctx.tenantId}::uuid,${version.id}::uuid,${setting},${bodyDigest(version.body)},${marked},${ctx.userId}::uuid)`);
  await event(tx,ctx,version.document_id,'teras-policy.text-only-marked',{versionId:version.id,setting,marked});
  return Object.freeze({setting,marked});
 });
}

/** "Send for approval": every value has a decision, and every enforceable setting the text mentions is confirmed or
 * marked text only. Whether it changes enforced settings is the database's to derive (any confirmed value), not ours. */
export async function submitPolicyVersion(supplied:SessionContext,input:Readonly<{versionId:unknown}>){
 const ctx=capture(supplied);requireAdministrator(ctx);
 const versionId=uuid.safeParse(input.versionId);if(!versionId.success)throw new PolicyRefused('invalid');
 const today=todayInKualaLumpur(),targets=await ownerTargets(ctx,today);
 const {version,values,marks}=await withTenant(ctx,async tx=>{
  const version=await versionTx(tx,ctx,versionId.data);
  if(version.status!=='draft')throw new PolicyRefused('not_draft');
  if(!(await adminAllTx(tx,version.id)))throw new PolicyRefused('not_administrator');
  return {version,values:await valuesTx(tx,ctx,version),marks:await marksTx(tx,ctx,version)};
 });
 if(values.some(v=>v.decision===null))throw new PolicyRefused('undecided');
 const {mentioned}=await consistencyOf(ctx,version,values,marks,targets,laterOf(version.effective_from,today),'pending');
 const uncoveredBy=(now:ReadonlyMap<PolicySetting,MarkRow>)=>mentioned.filter(setting=>!values.some(v=>v.setting===setting&&v.decision==='confirmed')&&now.get(setting)?.marked!==true);
 if(uncoveredBy(marks).length)throw new PolicyRefused('unmarked');
 return withTenant(ctx,async tx=>{
  const current=await versionTx(tx,ctx,version.id,true);
  if(current.status!=='draft'||current.body!==version.body)throw new PolicyRefused('not_draft');
  if(values.some(v=>v.decision==='confirmed')&&!(await coversTenantTx(tx,ctx,await scopeTx(tx,ctx,version.id))))throw new PolicyRefused('shared_setting');
  const recheck=await valuesTx(tx,ctx,current);
  if(recheck.length!==values.length||recheck.some((v,i)=>v.id!==values[i]!.id||v.decision!==values[i]!.decision))throw new PolicyRefused('undecided');
  if(uncoveredBy(await marksTx(tx,ctx,current)).length)throw new PolicyRefused('unmarked');
  const [sent]=rowsOf<{changes_settings:boolean}>(await tx.execute(sql`update public.teras_policy_version set status='submitted',submission=submission+1,
   submitted_by_user_id=${ctx.userId}::uuid,submitted_at=now() where id=${version.id}::uuid returning changes_settings`));
  const changes=sent!.changes_settings===true;
  await event(tx,ctx,version.document_id,'teras-policy.submitted',{versionId:version.id,version:version.version,submission:version.submission+1,changesSettings:changes,
   confirmed:values.filter(v=>v.decision==='confirmed').length,textOnly:[...marks.values()].filter(m=>m.marked).map(m=>m.setting)});
  return Object.freeze({changesSettings:changes});
 });
}

/** A group administrator returns a version sent for approval to its draft. */
export async function returnPolicyVersion(supplied:SessionContext,input:Readonly<{versionId:unknown}>){
 const ctx=capture(supplied);requireAdministrator(ctx);if(!isGroupAdmin(ctx))throw new PolicyRefused('not_group_admin');
 const versionId=uuid.safeParse(input.versionId);if(!versionId.success)throw new PolicyRefused('invalid');
 return withTenant(ctx,async tx=>{
  const version=await versionTx(tx,ctx,versionId.data,true);
  if(version.status!=='submitted')throw new PolicyRefused('not_submitted');
  await tx.execute(sql`insert into public.teras_policy_approval (tenant_id,version_id,submission,decision,approver_user_id) values (${ctx.tenantId}::uuid,${version.id}::uuid,${version.submission},'returned',${ctx.userId}::uuid)`);
  await tx.execute(sql`update public.teras_policy_version set status='draft',changes_settings=null,submitted_by_user_id=null,submitted_at=null where id=${version.id}::uuid`);
  await event(tx,ctx,version.document_id,'teras-policy.returned',{versionId:version.id,version:version.version,submission:version.submission});
  return Object.freeze({versionId:version.id});
 });
}

export type ApplicationResult=Readonly<{valueId:string;setting:PolicySetting;status:'applied'|'refused'|'scheduled';applyOn:string}>;
/** Applies, or schedules, every confirmed value of an approved version through its owner, and records each result. */
async function applyApproved(ctx:SessionContext,version:VersionRow,values:readonly ValueRow[],targets:OwnerTargets,today:string,only?:string){
 const results:ApplicationResult[]=[];
 const shared=await withTenant(ctx,async tx=>coversTenantTx(tx,ctx,await scopeTx(tx,ctx,version.id)));
 for(const value of values.filter(v=>v.decision==='confirmed'&&(!only||v.id===only))){
  const applyOn=laterOf(version.effective_from,today);
  const body=normalizeBody(value.setting,value.value)!;
  // ONE transaction: the owner's read, its own settings write, the read-back and the application row with its database
  // guard. Should the guard refuse the row, the owner's write rolls back with it. A refusal by the owner itself runs in
  // a savepoint, so it is recorded as refused and nothing of it stays.
  const status=await withTenant(ctx,async tx=>{
   let status:ApplicationResult['status'],before:SettingBody|null=null,after:SettingBody|null=null,message:string|null=null;
   const owner=await currentOwnerValueTx(tx,ctx,value.setting,value.target,targets,applyOn);
   before=owner.value;
   if(!shared){status='refused';message='This setting is shared by every company in the group, so the policy must apply to all of them.';}
   else if(sameValue(value.setting,owner.value,body)){status='applied';after=owner.value;}
   // Only a version derived as a settings change (a second administrator approved it) writes to an owner.
   else if(version.changes_settings!==true){status='refused';message='The system has changed since this version was sent. Prepare it again and send it for approval.';}
   else if(UNDATED_SETTINGS.has(value.setting)&&version.effective_from>today){status='scheduled';after=body;}
   else try{({before,after}=await tx.transaction(sp=>applyOwnerValueTx(sp as unknown as Tx,ctx,value.setting,value.target,body,targets,applyOn)));status='applied';}
   catch(error){status='refused';message=ownerMessage(error);}
   await tx.execute(sql`insert into public.teras_policy_application (tenant_id,version_id,value_id,status,before_value,after_value,apply_on,owner_message,applied_by_user_id)
    values (${ctx.tenantId}::uuid,${version.id}::uuid,${value.id}::uuid,${status},${before===null?null:JSON.stringify(before)}::jsonb,${after===null?null:JSON.stringify(after)}::jsonb,
     ${status==='scheduled'?version.effective_from:applyOn}::date,${message},${ctx.userId}::uuid)`);
   await event(tx,ctx,version.document_id,'teras-policy.value-'+status,{versionId:version.id,valueId:value.id,setting:value.setting,target:value.target,applyOn,
    before,after,...(message?{ownerMessage:message}:{})});
   return status;
  });
  results.push(Object.freeze({valueId:value.id,setting:value.setting,status,applyOn}));
 }
 return Object.freeze(results);
}

/** Whether a login contributed to a version (authored, edited, read or decided values, marked text only, or sent it). */
async function contributedTx(tx:Tx,versionId:string,userId:string){
 const [row]=rowsOf<{ok:boolean|null}>(await tx.execute(sql`select app.teras_policy_contributed(${versionId}::uuid,${userId}::uuid) as ok`));return row?.ok===true;
}

/** A group administrator approves a version sent for approval; on approval its confirmed values are applied by their
 * owners. Refused for a settings change the approver contributed to (the second, different administrator rule), and for
 * any version whose text states an enforceable figure that disagrees with what the system would then enforce. */
export async function approvePolicyVersion(supplied:SessionContext,input:Readonly<{versionId:unknown}>){
 const ctx=capture(supplied);requireAdministrator(ctx);if(!isGroupAdmin(ctx))throw new PolicyRefused('not_group_admin');
 const versionId=uuid.safeParse(input.versionId);if(!versionId.success)throw new PolicyRefused('invalid');
 const today=todayInKualaLumpur(),targets=await ownerTargets(ctx,today);
 const first=await withTenant(ctx,async tx=>{const version=await versionTx(tx,ctx,versionId.data);
  return {version,values:await valuesTx(tx,ctx,version),marks:await marksTx(tx,ctx,version),contributed:await contributedTx(tx,version.id,ctx.userId!)};});
 if(first.version.status!=='submitted')throw new PolicyRefused('not_submitted');
 if(first.version.changes_settings&&(first.contributed||first.version.author_user_id===ctx.userId||first.version.submitted_by_user_id===ctx.userId))throw new PolicyRefused('same_administrator');
 const checked=await consistencyOf(ctx,first.version,first.values,first.marks,targets,laterOf(first.version.effective_from,today),'pending');
 if(checked.disagreements.length)throw new PolicyRefused('mismatch');
 const version=await withTenant(ctx,async tx=>{
  const version=await versionTx(tx,ctx,versionId.data,true);
  if(version.status!=='submitted'||version.submission!==first.version.submission)throw new PolicyRefused('not_submitted');
  await tx.execute(sql`insert into public.teras_policy_approval (tenant_id,version_id,submission,decision,approver_user_id) values (${ctx.tenantId}::uuid,${version.id}::uuid,${version.submission},'approved',${ctx.userId}::uuid)`);
  await tx.execute(sql`update public.teras_policy_version set status='approved',approved_at=now() where id=${version.id}::uuid`);
  await event(tx,ctx,version.document_id,'teras-policy.approved',{versionId:version.id,version:version.version,submission:version.submission,changesSettings:version.changes_settings});
  return {...version,status:'approved' as const};
 });
 const applications=await applyApproved(ctx,version,first.values,targets,today);
 return Object.freeze({versionId:version.id,applications});
}

/** A scheduled value (an undated owner setting whose date has come) is applied by a group administrator. */
export async function applyScheduledValue(supplied:SessionContext,input:Readonly<{versionId:unknown;valueId:unknown}>){
 const ctx=capture(supplied);requireAdministrator(ctx);if(!isGroupAdmin(ctx))throw new PolicyRefused('not_group_admin');
 const versionId=uuid.safeParse(input.versionId),valueId=uuid.safeParse(input.valueId);if(!versionId.success||!valueId.success)throw new PolicyRefused('invalid');
 const today=todayInKualaLumpur(),targets=await ownerTargets(ctx,today);
 const {version,values,latest}=await withTenant(ctx,async tx=>{
  const version=await versionTx(tx,ctx,versionId.data);
  const [latest]=rowsOf<{status:string;apply_on:string}>(await tx.execute(sql`select status,to_char(apply_on,'YYYY-MM-DD') as apply_on from public.teras_policy_application
   where version_id=${version.id}::uuid and value_id=${valueId.data}::uuid order by applied_at desc,id desc limit 1`));
  return {version,values:await valuesTx(tx,ctx,version),latest};
 });
 if(version.status!=='approved')throw new PolicyRefused('not_approved');
 if(latest?.status!=='scheduled'||latest.apply_on>today)throw new PolicyRefused('not_due');
 return Object.freeze({applications:await applyApproved(ctx,{...version,effective_from:latest.apply_on},values,targets,today,valueId.data)});
}

/** The version of each policy in force today: the approved version with the latest date on or before today. */
const IN_FORCE=sql`(select distinct on (v.document_id) v.id from public.teras_policy_version v where v.status='approved' and v.effective_from<=(now() at time zone 'Asia/Kuala_Lumpur')::date
 order by v.document_id,v.effective_from desc,v.version desc)`;

const FIGURE=/\d[\d,]*(?:\.\d+)?/g;
/** The quote with the figure `from` written as `to`, at the quote's own precision; null when the figure is not in it. */
function replaceFigure(quote:string,from:number,to:number):string|null{
 const match=[...quote.matchAll(FIGURE)].find(m=>Math.abs(Number(m[0].replace(/,(?=\d{3}\b)/g,''))-from)<1e-9);
 if(!match||match.index===undefined)return null;
 const decimals=(match[0].split('.')[1]??'').length,text=to.toFixed(Math.max(decimals,(String(to).split('.')[1]??'').length));
 return quote.slice(0,match.index)+text+quote.slice(match.index+match[0].length);
}
/** Replace each figure in the quotes at `spans` (one change per span), from the end so earlier offsets stay true. */
function rewrite(body:string,changes:readonly Readonly<{span:PolicySpan;from:number;to:number}>[]):string|null{
 let out=body;
 for(const change of [...changes].sort((a,b)=>b.span.start-a.span.start)){
  if(out.slice(change.span.start,change.span.end)!==change.span.quote)return null;
  const quote=replaceFigure(change.span.quote,change.from,change.to);if(quote===null)return null;
  out=out.slice(0,change.span.start)+quote+out.slice(change.span.end);
 }
 return out;
}
/** The words of a value, as figures to replace: only when the owner's value keeps the policy's shape (same ranges). */
function rewritesFor(value:ValueRow,owner:SettingBody):readonly {span:PolicySpan;from:number;to:number}[]|null{
 const spans=value.spans;
 if(value.setting==='claims.submit_within_days'){const span=spans.find(s=>s.part==='days');return span?[{span,from:(value.value as {days:number}).days,to:(owner as {days:number}).days}]:null;}
 const mine=(value.value as {bands:readonly {fromKm?:number;toKm?:number|null;fromYears?:number;toYears?:number|null;ratePerKm?:number;days?:number}[]}).bands;
 const theirs=(owner as {bands:readonly {fromKm?:number;toKm?:number|null;fromYears?:number;toYears?:number|null;ratePerKm?:number;days?:number}[]}).bands;
 if(mine.length!==theirs.length)return null;
 const out:{span:PolicySpan;from:number;to:number}[]=[];
 for(let i=0;i<mine.length;i++){
  const a=mine[i]!,b=theirs[i]!;
  if(value.setting==='claims.mileage_rates'){
   if(a.fromKm!==b.fromKm||(a.toKm??null)!==(b.toKm??null))return null;
   if(a.ratePerKm!==b.ratePerKm){const span=spans.find(s=>s.part===`band.${i}.rate`);if(!span)return null;out.push({span,from:a.ratePerKm!,to:b.ratePerKm!});}
  }else{
   if(a.fromYears!==b.fromYears||(a.toYears??null)!==(b.toYears??null))return null;
   if(a.days!==b.days){const span=spans.find(s=>s.part===`band.${i}.days`);if(!span)return null;out.push({span,from:a.days!,to:b.days!});}
  }
 }
 return out;
}
/** Re-locates a value's quotes in new text (the same words, first unused occurrence). Null when one is gone. */
function relocate(body:string,spans:readonly PolicySpan[],replaced:ReadonlyMap<string,string>):PolicySpan[]|null{
 const used=new Set<number>(),out:PolicySpan[]=[];
 for(const span of spans){
  const quote=replaced.get(span.part)??span.quote;let at=body.indexOf(quote);
  while(at>=0&&used.has(at))at=body.indexOf(quote,at+1);
  if(at<0)return null;used.add(at);out.push({...span,start:at,end:at+quote.length,quote});
 }
 return out;
}

/** "Use the handbook" / "Update the handbook" on a drifted value of the version in force: a new draft, recorded as a
 * drift finding with both values. It applies nothing; it goes through confirmation and approval like any draft. */
export async function prepareFromDrift(supplied:SessionContext,input:Readonly<{versionId:unknown;valueId:unknown;resolution:unknown}>){
 const ctx=capture(supplied);requireAdministrator(ctx);
 const versionId=uuid.safeParse(input.versionId),valueId=uuid.safeParse(input.valueId);
 if(!versionId.success||!valueId.success||(input.resolution!=='use_handbook'&&input.resolution!=='update_handbook'))throw new PolicyRefused('invalid');
 const resolution=input.resolution,today=todayInKualaLumpur(),targets=await ownerTargets(ctx,today);
 const read=await withTenant(ctx,async tx=>{
  const version=await versionTx(tx,ctx,versionId.data);
  const [inForce]=rowsOf<{id:string}>(await tx.execute(sql`select id from ${IN_FORCE} f where f.id=${version.id}::uuid`));
  if(version.status!=='approved'||!inForce)throw new PolicyRefused('not_approved');
  if(!(await adminAllTx(tx,version.id)))throw new PolicyRefused('not_administrator');
  return {version,values:await valuesTx(tx,ctx,version),companies:await scopeTx(tx,ctx,version.id)};
 });
 const confirmed=read.values.filter(v=>v.decision==='confirmed'),drifted=confirmed.find(v=>v.id===valueId.data);
 if(!drifted)throw new PolicyRefused('not_found');
 const owner=(await currentOwnerValue(ctx,drifted.setting,drifted.target,targets,today)).value;
 if(sameValue(drifted.setting,owner,drifted.value))throw new PolicyRefused('no_drift');
 let body=read.version.body;const copies:{value:ValueRow;body:SettingBody;spans:PolicySpan[];source:'copied'|'drift'}[]=[];
 if(resolution==='update_handbook'){
  // The text is rewritten only where the owner's value keeps the policy's own shape; otherwise the draft keeps the text
  // and leaves this value out, for the administrator to reword.
  const changes=owner?rewritesFor(drifted,owner):null,next=changes?rewrite(body,changes):null;
  if(next!==null&&changes){
   const replaced=new Map(changes.map(c=>[c.span.part,replaceFigure(c.span.quote,c.from,c.to)!] as const));
   body=next;
   for(const value of confirmed){
    const spans=relocate(body,value.spans,value.id===drifted.id?replaced:new Map());
    if(spans)copies.push({value,body:value.id===drifted.id?normalizeBody(value.setting,owner)!:normalizeBody(value.setting,value.value)!,spans,source:value.id===drifted.id?'drift':'copied'});
   }
  }else for(const value of confirmed.filter(v=>v.id!==drifted.id))copies.push({value,body:normalizeBody(value.setting,value.value)!,spans:[...value.spans],source:'copied'});
 }else for(const value of confirmed)copies.push({value,body:normalizeBody(value.setting,value.value)!,spans:[...value.spans],source:'copied'});
 return withTenant(ctx,async tx=>{
  const draft=await insertVersionTx(tx,ctx,{documentId:read.version.document_id,body,effectiveFrom:laterOf(read.version.effective_from,today),
   origin:resolution,basedOn:read.version.id,companyIds:read.companies});
  const digest=bodyDigest(body);
  for(const copy of copies)await tx.execute(sql`insert into public.teras_policy_value (tenant_id,version_id,setting,target,value,spans,body_digest,source,proposed_by_user_id)
   values (${ctx.tenantId}::uuid,${draft.id}::uuid,${copy.value.setting},${JSON.stringify(copy.value.target)}::jsonb,${JSON.stringify(copy.body)}::jsonb,${JSON.stringify(copy.spans)}::jsonb,${digest},${copy.source},${ctx.userId}::uuid)`);
  await tx.execute(sql`insert into public.teras_policy_drift_finding (tenant_id,version_id,value_id,company_id,setting,handbook_value,system_value,resolution,prepared_version_id,resolved_by_user_id)
   values (${ctx.tenantId}::uuid,${read.version.id}::uuid,${drifted.id}::uuid,null,${drifted.setting},${JSON.stringify(normalizeBody(drifted.setting,drifted.value))}::jsonb,
    ${owner===null?null:JSON.stringify(owner)}::jsonb,${resolution},${draft.id}::uuid,${ctx.userId}::uuid)`);
  await event(tx,ctx,read.version.document_id,'teras-policy.drift-prepared',{versionId:read.version.id,valueId:drifted.id,setting:drifted.setting,resolution,draftVersionId:draft.id,
   textRewritten:body!==read.version.body});
  return Object.freeze({versionId:draft.id,textRewritten:body!==read.version.body});
 });
}

/** Makes an approved version (the one in force or an earlier one) the policy's next draft: "Edit text" on an approved
 * policy, and how a policy is taken back to an earlier version. Its confirmed values come along, for confirmation again. */
export async function draftFromVersion(supplied:SessionContext,input:Readonly<{versionId:unknown}>){
 const ctx=capture(supplied);requireAdministrator(ctx);
 const versionId=uuid.safeParse(input.versionId);if(!versionId.success)throw new PolicyRefused('invalid');
 const today=todayInKualaLumpur();
 return withTenant(ctx,async tx=>{
  const version=await versionTx(tx,ctx,versionId.data);
  if(version.status!=='approved')throw new PolicyRefused('not_approved');
  if(!(await adminAllTx(tx,version.id)))throw new PolicyRefused('not_administrator');
  const [latest]=rowsOf<{id:string}>(await tx.execute(sql`select id from public.teras_policy_version where document_id=${version.document_id}::uuid and status='approved' order by version desc limit 1`));
  const values=(await valuesTx(tx,ctx,version)).filter(v=>v.decision==='confirmed');
  const draft=await insertVersionTx(tx,ctx,{documentId:version.document_id,body:version.body,effectiveFrom:laterOf(version.effective_from,today),
   origin:latest?.id===version.id?'written':'restored',basedOn:version.id,companyIds:await scopeTx(tx,ctx,version.id)});
  for(const value of values)await tx.execute(sql`insert into public.teras_policy_value (tenant_id,version_id,setting,target,value,spans,body_digest,source,proposed_by_user_id)
   values (${ctx.tenantId}::uuid,${draft.id}::uuid,${value.setting},${JSON.stringify(value.target)}::jsonb,${JSON.stringify(value.value)}::jsonb,${JSON.stringify(value.spans)}::jsonb,${bodyDigest(version.body)},'copied',${ctx.userId}::uuid)`);
  await event(tx,ctx,version.document_id,'teras-policy.draft-from-version',{versionId:version.id,draftVersionId:draft.id});
  return Object.freeze({versionId:draft.id});
 });
}

// ───────────────────────────── Views ─────────────────────────────

export type PolicyCompany=Readonly<{id:string;name:string}>;
export type PolicyListItem=Readonly<{id:string;area:PolicyArea;title:string;inForce:number|null;open:Readonly<{version:number;status:'draft'|'submitted'}>|null;drift:number}>;
export type PolicyValueView=Readonly<{id:string;setting:PolicySetting;target:SettingTarget;targetName:string|null;value:SettingBody;spans:readonly PolicySpan[];
 source:string;decision:'confirmed'|'rejected'|null;now:SettingBody|null;nowDefaulted:boolean;differs:boolean}>;
/** A disagreement of the version in force with the owners now: a confirmed value (kind 'value', resolvable with "Use the
 * handbook" / "Update the handbook"), or other words of its text that state an enforceable figure (kind 'text', with
 * those words; an administrator edits the text). */
export type PolicyDrift=Readonly<{kind:'value'|'text';valueId:string|null;setting:PolicySetting;target:SettingTarget;targetName:string|null;handbook:SettingBody|null;quote:string|null;
 system:SettingBody|null;companies:readonly string[]}>;
/** Words of an unapproved version's text that state an enforceable figure the system would not enforce once approved. */
export type PolicyMismatch=Readonly<{setting:PolicySetting;target:SettingTarget;targetName:string|null;quote:string;source:'text'|'value';valueId:string|null;enforced:SettingBody|null}>;
/** An enforceable setting the version's text mentions, and how it is covered: a confirmed value, a person's text-only
 * mark (who, when), or neither (it must be one or the other before the version is sent). */
export type PolicyMention=Readonly<{setting:PolicySetting;confirmed:boolean;textOnly:Readonly<{byName:string|null;at:Date}>|null}>;
export type PolicyApplicationView=Readonly<{valueId:string;setting:PolicySetting;status:'applied'|'refused'|'scheduled';applyOn:string;before:SettingBody|null;after:SettingBody|null;ownerMessage:string|null;at:Date}>;
export type PolicyVersionView=Readonly<{id:string;version:number;status:'draft'|'submitted'|'approved';effectiveFrom:string;origin:string;authorName:string|null;authorIsViewer:boolean;
 submittedByViewer:boolean;contributedByViewer:boolean;submittedAt:Date|null;approvedAt:Date|null;changesSettings:boolean|null;body:string;companies:readonly string[]}>;
export type PolicyDetail=Readonly<{id:string;area:PolicyArea;title:string;current:PolicyVersionView;inForceId:string|null;versions:readonly PolicyVersionView[];
 values:readonly PolicyValueView[];settings:readonly PolicySetting[];sharedOk:boolean;canEdit:boolean;
 mentions:readonly PolicyMention[];mismatches:readonly PolicyMismatch[];
 approvals:readonly Readonly<{decision:'approved'|'returned';approverName:string|null;submission:number;at:Date}>[];
 applications:readonly PolicyApplicationView[];drift:readonly PolicyDrift[];impact:ClaimPolicyImpact|null}>;
export type ReaderPolicy=Readonly<{id:string;area:PolicyArea;title:string;version:number;effectiveFrom:string;body:string}>;
export type PoliciesView=Readonly<{role:'admin';today:string;companies:readonly PolicyCompany[];isGroupAdmin:boolean;list:readonly PolicyListItem[];selected:PolicyDetail|null}>
 |Readonly<{role:'reader';today:string;list:readonly PolicyListItem[];selected:ReaderPolicy|null}>;

async function namesTx(tx:Tx,userIds:readonly (string|null)[]):Promise<Map<string,string|null>>{
 const wanted=[...new Set(userIds.filter((id):id is string=>!!id))];if(!wanted.length)return new Map();
 const rows=rowsOf<{id:string;name:string|null}>(await tx.execute(sql`select u.id,p.full_name as name from public.app_user u left join public.person p on p.id=u.person_id where u.id = any(${ids(wanted)})`));
 return new Map(rows.map(r=>[r.id,r.name]));
}
const targetName=(targets:OwnerTargets,setting:PolicySetting,target:SettingTarget)=>setting==='claims.mileage_rates'?targets.mileageType?.name??null
 :setting==='claims.submit_within_days'?claimTypeOf(targets,target)?.name??null:targets.leaveTypes.find(t=>t.code.toUpperCase()===(target.leaveType??'').toUpperCase())?.name??null;

/** Drift of one approved version against the owners now (deterministic, read-only): each confirmed value, then every
 * other enforceable figure its text states (rejected values and the deterministic read, ./consistency.ts). */
async function driftOf(ctx:SessionContext,version:Pick<VersionRow,'body'>,values:readonly ValueRow[],targets:OwnerTargets,today:string,companies:readonly string[]):Promise<PolicyDrift[]>{
 const out:PolicyDrift[]=[];
 for(const value of values.filter(v=>v.decision==='confirmed')){
  const owner=await currentOwnerValue(ctx,value.setting,value.target,targets,today);
  if(!owner.available||sameValue(value.setting,owner.value,value.value))continue;
  out.push(Object.freeze({kind:'value' as const,valueId:value.id,setting:value.setting,target:value.target,targetName:targetName(targets,value.setting,value.target),
   handbook:normalizeBody(value.setting,value.value)!,quote:null,system:owner.value,companies}));
 }
 const text=await consistencyOf(ctx,version,values,new Map(),targets,today,'in_force');
 for(const found of text.disagreements)out.push(Object.freeze({kind:'text' as const,valueId:found.statement.valueId,setting:found.statement.setting,target:found.target,
  targetName:targetName(targets,found.statement.setting,found.target),handbook:null,quote:found.statement.quote,system:found.enforced,companies}));
 return out;
}

/** AI Centre › Policies, as the viewer may see it: administrators get every policy of the companies they administer
 * (drafts, values, approvals, applications and drift); everyone else the approved versions of their own companies. */
export async function policiesView(supplied:SessionContext,input:Readonly<{policy?:unknown}>):Promise<PoliciesView>{
 const ctx=capture(supplied),today=todayInKualaLumpur();
 const policyId=uuid.safeParse(input.policy).success?input.policy as string:null;
 const admin=!!ctx.userId&&!ctx.agent&&isAdmin(ctx);
 if(!admin){
  return withTenant(ctx,async tx=>{
   const rows=rowsOf<{id:string;area:PolicyArea;title:string;version:number;effective_from:string;body:string}>(await tx.execute(sql`select d.id,d.area,d.title,v.version,
    to_char(v.effective_from,'YYYY-MM-DD') as effective_from,v.body from public.teras_policy_document d join public.teras_policy_version v on v.document_id=d.id
    where d.tenant_id=${ctx.tenantId}::uuid and v.id in ${IN_FORCE} order by d.area,d.title,d.id`));
   const list=rows.map(r=>Object.freeze({id:r.id,area:r.area,title:r.title,inForce:r.version,open:null,drift:0}));
   const chosen=rows.find(r=>r.id===policyId)??null;
   return Object.freeze({role:'reader' as const,today,list:Object.freeze(list),selected:chosen?Object.freeze({id:chosen.id,area:chosen.area,title:chosen.title,version:chosen.version,effectiveFrom:chosen.effective_from,body:chosen.body}):null});
  });
 }
 const targets=await ownerTargets(ctx,today);
 const base=await withTenant(ctx,async tx=>{
  const companies=rowsOf<{id:string;legal_name:string}>(await tx.execute(sql`select c.id,c.legal_name from public.company c where c.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(c.id) is true order by c.legal_name,c.id`));
  const docs=rowsOf<{id:string;area:PolicyArea;title:string;in_force_id:string|null;in_force:number|null;open_id:string|null;open:number|null;open_status:'draft'|'submitted'|null}>(await tx.execute(sql`select d.id,d.area,d.title,
   f.id as in_force_id,f.version as in_force,o.id as open_id,o.version as open,o.status as open_status
   from public.teras_policy_document d
   left join public.teras_policy_version f on f.document_id=d.id and f.id in ${IN_FORCE}
   left join public.teras_policy_version o on o.document_id=d.id and o.status<>'approved'
   where d.tenant_id=${ctx.tenantId}::uuid and exists(select 1 from public.teras_policy_version v where v.document_id=d.id and app.teras_policy_admin_any(v.id))
   order by d.area,d.title,d.id`));
  const inForceValues=new Map<string,ValueRow[]>(),inForceBodies=new Map<string,string>(),scopes=new Map<string,string[]>();
  for(const doc of docs)if(doc.in_force_id){
   const v=await versionTx(tx,ctx,doc.in_force_id);inForceValues.set(doc.id,await valuesTx(tx,ctx,v));inForceBodies.set(doc.id,v.body);scopes.set(doc.id,await scopeTx(tx,ctx,v.id));
  }
  return {companies:companies.map(c=>Object.freeze({id:c.id,name:c.legal_name})),docs,inForceValues,inForceBodies,scopes};
 });
 const driftByDoc=new Map<string,PolicyDrift[]>();
 for(const doc of base.docs)if(doc.in_force_id)driftByDoc.set(doc.id,await driftOf(ctx,{body:base.inForceBodies.get(doc.id)??''},base.inForceValues.get(doc.id)??[],targets,today,base.scopes.get(doc.id)??[]));
 const list=base.docs.map(d=>Object.freeze({id:d.id,area:d.area,title:d.title,inForce:d.in_force,open:d.open&&d.open_status?Object.freeze({version:d.open,status:d.open_status}):null,drift:driftByDoc.get(d.id)?.length??0}));
 const chosen=base.docs.find(d=>d.id===policyId)??null;
 let selected:PolicyDetail|null=null;
 if(chosen){
  const detail=await withTenant(ctx,async tx=>{
   const versions=rowsOf<{id:string}>(await tx.execute(sql`select id from public.teras_policy_version where document_id=${chosen.id}::uuid order by version desc`));
   const rows:VersionRow[]=[];for(const v of versions)rows.push(await versionTx(tx,ctx,v.id));
   const current=rows.find(r=>r.id===chosen.open_id)??rows.find(r=>r.id===chosen.in_force_id)??rows[0]!;
   const scopes=new Map<string,string[]>();for(const r of rows)scopes.set(r.id,await scopeTx(tx,ctx,r.id));
   const values=await valuesTx(tx,ctx,current);
   const approvals=rowsOf<{decision:'approved'|'returned';approver_user_id:string;submission:number;decided_at:Date}>(await tx.execute(sql`select decision,approver_user_id,submission,decided_at
    from public.teras_policy_approval where version_id=${current.id}::uuid order by decided_at,id`));
   const applications=rowsOf<{value_id:string;setting:PolicySetting;status:'applied'|'refused'|'scheduled';apply_on:string;before_value:SettingBody|null;after_value:SettingBody|null;owner_message:string|null;applied_at:Date}>(
    await tx.execute(sql`select a.value_id,x.setting,a.status,to_char(a.apply_on,'YYYY-MM-DD') as apply_on,a.before_value,a.after_value,a.owner_message,a.applied_at
     from public.teras_policy_application a join public.teras_policy_value x on x.id=a.value_id where a.version_id=${current.id}::uuid order by a.applied_at,a.id`));
   const marks=await marksTx(tx,ctx,current);
   const names=await namesTx(tx,[...rows.map(r=>r.author_user_id),...approvals.map(a=>a.approver_user_id),...[...marks.values()].map(m=>m.by)]);
   const canEdit=await adminAllTx(tx,current.id),{settings,sharedOk}=await enforceableTx(tx,ctx,current,targets);
   const contributed=ctx.userId?await contributedTx(tx,current.id,ctx.userId):false;
   return {rows,current,scopes,values,approvals,applications,names,canEdit,settings,sharedOk,marks,contributed};
  });
  const viewOf=(r:VersionRow):PolicyVersionView=>Object.freeze({id:r.id,version:r.version,status:r.status,effectiveFrom:r.effective_from,origin:r.origin,authorName:detail.names.get(r.author_user_id)??null,
   authorIsViewer:r.author_user_id===ctx.userId,submittedByViewer:r.submitted_by_user_id===ctx.userId,contributedByViewer:r.id===detail.current.id?detail.contributed:false,
   submittedAt:r.submitted_at,approvedAt:r.approved_at,changesSettings:r.changes_settings,body:r.body,companies:Object.freeze(detail.scopes.get(r.id)??[])});
  const asOf=laterOf(detail.current.effective_from,today),values:PolicyValueView[]=[];
  for(const v of detail.values){
   const owner=await currentOwnerValue(ctx,v.setting,v.target,targets,asOf);
   values.push(Object.freeze({id:v.id,setting:v.setting,target:v.target,targetName:targetName(targets,v.setting,v.target),value:normalizeBody(v.setting,v.value)!,spans:v.spans,source:v.source,
    decision:v.decision,now:owner.value,nowDefaulted:owner.defaulted,differs:!sameValue(v.setting,owner.value,v.value)}));
  }
  // The claims service's impact of the values not rejected, over its last twelve months of real claims.
  let impact:ClaimPolicyImpact|null=null;
  const live=values.filter(v=>v.decision!=='rejected'),mileage=live.find(v=>v.setting==='claims.mileage_rates'),within=live.find(v=>v.setting==='claims.submit_within_days');
  const withinType=within?claimTypeOf(targets,within.target):null;
  if(detail.current.status!=='approved'&&(mileage||withinType))impact=await simulateClaimPolicyImpact(ctx,{
   mileageBands:mileage?(mileage.value as {bands:readonly {fromKm:number;toKm:number|null;ratePerKm:number}[]}).bands.map(b=>({...b})):null,
   submitWithin:within&&withinType?{claimTypeId:withinType.id,days:(within.value as {days:number}).days}:null}).catch(()=>null);
  // What the text states against what the system would enforce, and how each mentioned setting is covered. For the
  // version in force the drift above already says it; for a draft or a version waiting, it is what blocks approval.
  let mentions:PolicyMention[]=[],mismatches:PolicyMismatch[]=[];
  if(detail.current.status!=='approved'){
   const checked=await consistencyOf(ctx,detail.current,detail.values,detail.marks,targets,asOf,'pending');
   mentions=checked.mentioned.map(setting=>{const mark=detail.marks.get(setting);
    return Object.freeze({setting,confirmed:detail.values.some(v=>v.setting===setting&&v.decision==='confirmed'),
     textOnly:mark?.marked?Object.freeze({byName:detail.names.get(mark.by)??null,at:mark.at}):null});});
   mismatches=checked.disagreements.map(found=>Object.freeze({setting:found.statement.setting,target:found.target,targetName:targetName(targets,found.statement.setting,found.target),
    quote:found.statement.quote,source:found.statement.source,valueId:found.statement.valueId,enforced:found.enforced}));
  }
  selected=Object.freeze({id:chosen.id,area:chosen.area,title:chosen.title,current:viewOf(detail.current),inForceId:chosen.in_force_id,versions:Object.freeze(detail.rows.map(viewOf)),
   values:Object.freeze(values),settings:detail.settings,sharedOk:detail.sharedOk,canEdit:detail.canEdit,mentions:Object.freeze(mentions),mismatches:Object.freeze(mismatches),
   approvals:Object.freeze(detail.approvals.map(a=>Object.freeze({decision:a.decision,approverName:detail.names.get(a.approver_user_id)??null,submission:a.submission,at:a.decided_at}))),
   applications:Object.freeze(detail.applications.map(a=>Object.freeze({valueId:a.value_id,setting:a.setting,status:a.status,applyOn:a.apply_on,before:a.before_value,after:a.after_value,ownerMessage:a.owner_message,at:a.applied_at}))),
   drift:Object.freeze(driftByDoc.get(chosen.id)??[]),impact});
 }
 return Object.freeze({role:'admin' as const,today,companies:Object.freeze(base.companies),isGroupAdmin:isGroupAdmin(ctx),list:Object.freeze(list),selected});
}
