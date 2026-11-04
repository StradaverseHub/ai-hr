/** AI v2 Phase 2, P2-5 — the Ask read my_policy_handbook (core/semantic-model/entities-handbook.ts): employees' policy
 * questions answered from the APPROVED version in force only, with a citation.
 *
 * Runs as the caller under the 0971 row-level security: a login reads the approved versions of policies that apply to a
 * company they work in (an administrator also those of the companies they administer), and never a draft, a version
 * sent for approval, a value or an approval. Of those, only the version in force today counts (the approved version with
 * the latest date on or before today). The text is split into numbered paragraphs; with a topic, the paragraphs that
 * share its words are returned first. Each policy carries the citation the reply must give: its title, version and the
 * paragraph numbers. Nothing here decides what the person may see; the harness discloses by the entity's classes, and its
 * identifier screen turns any email address, IC, phone or bank account written in a paragraph into `[<kind> removed]`
 * before the model sees it (the person reads the policy itself on /policies).
 *
 * NEVER A FIGURE THE SYSTEM DOES NOT ENFORCE (Phase 2 hardening, 4 November 2026). Each enforceable figure the approved
 * text states, read deterministically (./consistency.ts: mileage rates, claim submission windows), is held against the
 * owner's current setting as the asking person reads it. Where they disagree, the answer never carries the handbook's
 * figure: its words are replaced by the current setting and a note that the two differ, and the same disagreement is on
 * HR's Policies page as drift (core/handbook/policies.ts driftOf), where HR resolves it. Nothing is calculated. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {provenance,refuse,type ExplainerOutcome} from '../explainers/outcome';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {disagreements,readStatedFigures,settingKey,type PolicyDisagreement} from './consistency';
import {claimTypeOf,currentOwnerValue,heldSettings,ownerTargets,type OwnerTargets,type PolicySetting,type SettingBody,type SettingTarget} from './settings';

const MAX_POLICIES=6,MAX_PARAGRAPHS=8;
const words=(text:string)=>new Set(text.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>=3));
export function paragraphsOf(body:string):string[]{return body.split(/\n\s*\n|\n/).map(p=>p.trim()).filter(Boolean);}

export type HandbookRow=Readonly<{title:string;area:string;version:number;effectiveFrom:string;body:string}>;
/** The approved versions in force today that the caller may read. */
export async function readPoliciesInForce(ctx:SessionContext):Promise<readonly HandbookRow[]>{
 return withTenant(ctx,async tx=>{
  const rows=Array.from(await tx.execute(sql`select d.title,d.area,v.version,to_char(v.effective_from,'YYYY-MM-DD') as effective_from,v.body
   from public.teras_policy_version v join public.teras_policy_document d on d.id=v.document_id
   where v.tenant_id=${ctx.tenantId}::uuid and v.id in (select distinct on (x.document_id) x.id from public.teras_policy_version x where x.status='approved'
    and x.effective_from<=(now() at time zone 'Asia/Kuala_Lumpur')::date order by x.document_id,x.effective_from desc,x.version desc)
   order by d.area,d.title`) as unknown as {title:string;area:string;version:number;effective_from:string;body:string}[]);
  return Object.freeze(rows.map(r=>Object.freeze({title:r.title,area:r.area,version:r.version,effectiveFrom:r.effective_from,body:r.body})));
 });
}

const figure=(n:number)=>Number(n.toFixed(2))===n?n.toFixed(2):String(n);
/** The owner's setting in words, for the answer (English, as the rest of the read; the reply is phrased by the model). */
function settingWords(setting:PolicySetting,target:SettingTarget,value:SettingBody|null,targets:OwnerTargets):string{
 if(setting==='claims.mileage_rates'){
  if(value===null)return 'no mileage rate is set';
  const bands=(value as {bands:readonly {fromKm:number;toKm:number|null;ratePerKm:number}[]}).bands;
  return bands.map(b=>`RM ${figure(b.ratePerKm)} per km`+(bands.length>1?(b.toKm===null?` from ${b.fromKm} km`:` from ${b.fromKm} to ${b.toKm} km`):'')).join(', ');
 }
 if(setting==='claims.submit_within_days'){
  const name=claimTypeOf(targets,target)?.name??target.claimType??'';
  return value===null?`no submission window is set for ${name} claims`:`${name} claims are submitted within ${(value as {days:number}).days} days`;
 }
 return value===null?'no entitlement table is set':(value as {bands:readonly {fromYears:number;toYears:number|null;days:number}[]}).bands
  .map(b=>`${b.days} days`+(b.toYears===null?` from ${b.fromYears} years`:` from ${b.fromYears} to ${b.toYears} years`)).join(', ');
}
/** The approved text with every enforceable figure that disagrees with the current setting replaced by that setting. */
async function withCurrentSettings(ctx:SessionContext,body:string,targets:OwnerTargets,today:string):Promise<string>{
 const statements=readStatedFigures(body,heldSettings(targets),targets.claimTypes);if(!statements.length)return body;
 const codes=targets.claimTypes.map(t=>t.code),owner=new Map<string,SettingBody|null>();
 try{
  for(const statement of statements){
   const wanted=statement.target?[statement.target]:statement.setting==='claims.submit_within_days'?codes.map(code=>({claimType:code})):[{}];
   for(const target of wanted){const key=settingKey(statement.setting,target);if(!owner.has(key))owner.set(key,(await currentOwnerValue(ctx,statement.setting,target,targets,today)).value);}
  }
 }catch{
  // The setting cannot be read now, so no figure is given for it at all.
  let out=body;for(const statement of [...statements].sort((a,b)=>b.start-a.start))out=out.slice(0,statement.start)+'[the current setting could not be read; ask HR]'+out.slice(statement.end);
  return out;
 }
 const found=disagreements(statements,(setting,target)=>owner.get(settingKey(setting,target))??null,codes);
 const bySpan=new Map<number,PolicyDisagreement[]>();for(const d of found)bySpan.set(d.statement.start,[...(bySpan.get(d.statement.start)??[]),d]);
 let out=body;
 for(const start of [...bySpan.keys()].sort((a,b)=>b-a)){
  const list=bySpan.get(start)!,statement=list[0]!.statement;
  const now=list.map(d=>settingWords(d.statement.setting,d.target,d.enforced,targets)).join('; ');
  out=out.slice(0,statement.start)+`[current setting: ${now}. The handbook's figure here differs from what the system applies; HR has been flagged to correct it]`+out.slice(statement.end);
 }
 return out;
}

export async function askPolicyHandbook(ctx:SessionContext,input:Readonly<{topic?:string}>):Promise<ExplainerOutcome>{
 if(!ctx.userId||ctx.agent)return refuse('not_permitted','Only a signed-in person reads their company policies.');
 const read=await readPoliciesInForce(ctx);
 const today=todayInKualaLumpur(),targets=read.length?await ownerTargets(ctx,today):null;
 const rows:HandbookRow[]=[];
 for(const row of read)rows.push(targets?Object.freeze({...row,body:await withCurrentSettings(ctx,row.body,targets,today)}):row);
 if(!rows.length)return refuse('no_data','No approved company policy applies to this person yet.');
 const topic=words(typeof input.topic==='string'?input.topic.slice(0,200):'');
 const scored=rows.map(row=>{
  const paragraphs=paragraphsOf(row.body).map((text,i)=>({paragraph:i+1,text,score:[...words(text)].filter(w=>topic.has(w)).length+(topic.size&&[...words(row.title)].some(w=>topic.has(w))?0.5:0)}));
  return {row,paragraphs,score:Math.max(0,...paragraphs.map(p=>p.score))};
 });
 const matched=topic.size?scored.filter(s=>s.score>0).sort((a,b)=>b.score-a.score):[];
 const chosen=(matched.length?matched:scored).slice(0,MAX_POLICIES);
 return{ok:true,matchedTopic:matched.length>0,
  policies:chosen.map(({row,paragraphs})=>{
   const picked=(matched.length?paragraphs.filter(p=>p.score>0).sort((a,b)=>b.score-a.score||a.paragraph-b.paragraph):paragraphs).slice(0,MAX_PARAGRAPHS).sort((a,b)=>a.paragraph-b.paragraph);
   return{title:row.title,area:row.area,version:row.version,effectiveFrom:row.effectiveFrom,citation:`${row.title}, version ${row.version}, paragraph ${picked.map(p=>p.paragraph).join(', ')}`,
    paragraphs:picked.map(p=>({paragraph:p.paragraph,text:p.text})),paragraphCount:paragraphs.length};
  }),
  otherPolicies:scored.filter(s=>!chosen.includes(s)).map(s=>s.row.title),
  provenance:provenance('core/handbook/ask.ts#readPoliciesInForce','The approved policy version in force today (teras_policy_version, migration 0971).','/policies',
   'Answer only from these approved paragraphs and cite the policy title, version and paragraph. If they do not answer the question, say so and suggest asking HR; never guess a rule. Where a paragraph shows [current setting: …], give that setting, say the handbook\'s wording differs and HR has been flagged, and never state another figure for it.')};
}
