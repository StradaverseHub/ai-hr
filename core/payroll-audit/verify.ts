/** AI v2 P2-2b — tamper evidence for the Audit loop's captures of one company and pay month.
 *
 * Recomputes everything in SQL with the same functions the triggers used (app.payroll_audit_hash, app.payroll_audit_chain_hash),
 * so the writer and the verifier cannot diverge (the core/audit-chain.ts pattern):
 *  - seq not contiguous from 1              -> a capture was deleted or inserted out of turn (`gap`);
 *  - prev_hash not the previous chain_hash  -> captures were reordered or one replaced (`reorder`);
 *  - content_hash not the hash of content   -> a captured artefact was changed (`mutated`);
 *  - chain_hash not the hash of the row     -> a captured row's identity, time or writer was changed (`mutated`).
 * Then each capture is matched to its anchor in the tenant audit log (the `payroll-audit.captured` domain event the database
 * wrote with it): a capture whose anchor is missing or disagrees is `unanchored`, and an anchor whose capture is gone is
 * `missing` (this is what catches a deleted last capture, which the chain alone cannot). Anchors are domain events, which
 * only administrators read; for anyone else the anchor check reports `visible: false` rather than a false pass. How many
 * anchors sit inside the tenant hash chain (chain_seq set) says whether the anchors are themselves tamper-evident there.
 * Read-only. */
import {sql} from 'drizzle-orm';
import type {Tx} from '../../db/client';

export type CaptureIssue=Readonly<{seq:number|null;captureId:string|null;problem:'gap'|'reorder'|'mutated'|'unanchored'|'missing'}>;
export type CaptureVerification=Readonly<{valid:boolean;checked:number;head:string|null;
 anchors:Readonly<{visible:boolean;matched:number;inAuditChain:number}>;issues:readonly CaptureIssue[]}>;

export async function verifyCapturesTx(tx:Tx,tenantId:string,p:Readonly<{companyId:string;payPeriod:string}>):Promise<CaptureVerification>{
 const broken=Array.from(await tx.execute(sql`with ordered as (
   select c.*,lag(c.chain_hash) over (order by c.seq) as prior_hash,lag(c.seq) over (order by c.seq) as prior_seq from public.payroll_audit_capture c
   where c.tenant_id=${tenantId}::uuid and c.company_id=${p.companyId}::uuid and c.pay_period=${p.payPeriod})
  select id,seq,problem from (select id,seq,case
    when seq<>coalesce(prior_seq,0)+1 then 'gap'
    when prev_hash is distinct from coalesce(prior_hash,'GENESIS') then 'reorder'
    when content_hash is distinct from app.payroll_audit_hash(content::text) then 'mutated'
    when chain_hash is distinct from app.payroll_audit_chain_hash(prev_hash,tenant_id,company_id,pay_period,seq,kind,source_key,content_hash,captured_at,writer,writer_id) then 'mutated'
    else null end as problem from ordered) q where problem is not null order by seq`) as unknown as {id:string;seq:number;problem:CaptureIssue['problem']}[]);
 const [summary]=await tx.execute(sql`select count(*)::int as n,(select chain_hash from public.payroll_audit_capture h where h.tenant_id=${tenantId}::uuid
   and h.company_id=${p.companyId}::uuid and h.pay_period=${p.payPeriod} order by h.seq desc limit 1) as head
  from public.payroll_audit_capture c where c.tenant_id=${tenantId}::uuid and c.company_id=${p.companyId}::uuid and c.pay_period=${p.payPeriod}`) as unknown as {n:number;head:string|null}[];
 const checked=Number(summary?.n??0);
 const issues:CaptureIssue[]=broken.map(row=>Object.freeze({seq:Number(row.seq),captureId:row.id,problem:row.problem}));
 // The anchors, where this reader may see domain events (administrators).
 const [visible]=await tx.execute(sql`select app.is_admin() as ok`) as unknown as {ok:boolean|null}[];
 let anchors={visible:false,matched:0,inAuditChain:0};
 if(visible?.ok===true){
  const unanchored=Array.from(await tx.execute(sql`select c.id,c.seq from public.payroll_audit_capture c where c.tenant_id=${tenantId}::uuid and c.company_id=${p.companyId}::uuid
   and c.pay_period=${p.payPeriod} and not exists (select 1 from public.domain_event d where d.tenant_id=c.tenant_id and d.aggregate_type='payroll-audit'
    and d.aggregate_id=c.id and d.event_type='payroll-audit.captured' and d.payload->>'chainHash'=c.chain_hash and d.payload->>'contentHash'=c.content_hash
    and (d.payload->>'seq')::int=c.seq) order by c.seq`) as unknown as {id:string;seq:number}[]);
  const missing=Array.from(await tx.execute(sql`select d.aggregate_id,(d.payload->>'seq')::int as seq from public.domain_event d where d.tenant_id=${tenantId}::uuid
   and d.aggregate_type='payroll-audit' and d.event_type='payroll-audit.captured' and d.payload->>'companyId'=${p.companyId} and d.payload->>'payPeriod'=${p.payPeriod}
   and not exists (select 1 from public.payroll_audit_capture c where c.id=d.aggregate_id and c.tenant_id=d.tenant_id) order by 2`) as unknown as {aggregate_id:string;seq:number}[]);
  const [counts]=await tx.execute(sql`select count(*)::int as n,count(*) filter (where d.chain_seq is not null)::int as chained from public.domain_event d
   where d.tenant_id=${tenantId}::uuid and d.aggregate_type='payroll-audit' and d.event_type='payroll-audit.captured'
   and d.payload->>'companyId'=${p.companyId} and d.payload->>'payPeriod'=${p.payPeriod}
   and exists (select 1 from public.payroll_audit_capture c where c.id=d.aggregate_id and c.tenant_id=d.tenant_id and c.chain_hash=d.payload->>'chainHash')`) as unknown as {n:number;chained:number}[];
  for(const row of unanchored)issues.push(Object.freeze({seq:Number(row.seq),captureId:row.id,problem:'unanchored'}));
  for(const row of missing)issues.push(Object.freeze({seq:Number(row.seq),captureId:row.aggregate_id,problem:'missing'}));
  anchors={visible:true,matched:Number(counts?.n??0),inAuditChain:Number(counts?.chained??0)};
 }
 issues.sort((a,b)=>(a.seq??0)-(b.seq??0));
 return Object.freeze({valid:issues.length===0,checked,head:summary?.head??null,anchors:Object.freeze(anchors),issues:Object.freeze(issues)});
}
