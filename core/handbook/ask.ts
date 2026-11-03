/** AI v2 Phase 2, P2-5 — the Ask read my_policy_handbook (core/semantic-model/entities-handbook.ts): employees' policy
 * questions answered from the APPROVED version in force only, with a citation.
 *
 * Runs as the caller under the 0971 row-level security: a login reads the approved versions of policies that apply to a
 * company they work in (an administrator also those of the companies they administer), and never a draft, a version
 * sent for approval, a value or an approval. Of those, only the version in force today counts (the approved version with
 * the latest date on or before today). The text is split into numbered paragraphs; with a topic, the paragraphs that
 * share its words are returned first. Each policy carries the citation the reply must give: its title, version and the
 * paragraph numbers. Nothing here decides what the person may see; the harness discloses by the entity's classes. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {provenance,refuse,type ExplainerOutcome} from '../explainers/outcome';

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

export async function askPolicyHandbook(ctx:SessionContext,input:Readonly<{topic?:string}>):Promise<ExplainerOutcome>{
 if(!ctx.userId||ctx.agent)return refuse('not_permitted','Only a signed-in person reads their company policies.');
 const rows=await readPoliciesInForce(ctx);
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
   'Answer only from these approved paragraphs and cite the policy title, version and paragraph. If they do not answer the question, say so and suggest asking HR; never guess a rule.')};
}
