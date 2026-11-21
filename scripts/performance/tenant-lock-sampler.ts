/**
 * Independent sampler for every tenant-wide advisory key a bulk job can hold (DESIGN.md acceptance: "no transaction
 * holds a tenant lock longer than 1 s"). Polls pg_locks on an owner connection and attributes each hold by backend,
 * transaction start, application_name and the ordered distinct statements seen while it was held. Rehearsal only.
 */
import type postgres from 'postgres';

export type TenantLockHold={lock:string;mode:string;pid:number;app:string;ms:number;queries:string[]};
export type TenantLockReport={byLock:Record<string,{holds:number;maxMs:number;over1s:number}>;longest:TenantLockHold[];holds:TenantLockHold[];
 /** The same per holder: a bulk job's labelled transactions (application_name aihr-bulk:<kind>:<phase>) or everything else. */
 byHolder:Record<string,{holds:number;maxMs:number;over1s:number}>;
 /** The same, per application_name (a bulk job labels its transactions aihr-bulk:<kind>:<phase>; probes are unlabelled). */
 byApp:Record<string,{holds:number;maxMs:number;over1s:number;p95Ms:number}>};

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

/** `extra` adds a kind's own tenant-wide keys, as [name, key, 'ext' (hashtextextended) or 'int4' (hashtext)]. */
export async function startTenantLockSampler(obs:postgres.Sql,tenantId:string,intervalMs=25,extra:[string,string,'ext'|'int4'][]=[]){
 const names:[string,string,'ext'|'int4'][]=[...extra,
  ['access','access-configuration:'+tenantId,'ext'],
  ['leave','leave-dependency-configuration:'+tenantId,'ext'],
  ['profile','profile-edit-policy:'+tenantId,'ext'],
  ['cards',tenantId+':card-identifiers','ext'],
  ['audit','audit-chain:'+tenantId,'int4'],
 ];
 const keys:{name:string;classid:string;objid:string}[]=[];
 for(const [name,key,kind] of names){
  const [row]=await obs<{classid:string;objid:string}[]>`select ((k>>32)&4294967295)::oid::text as classid,(k&4294967295)::oid::text as objid
   from (select case when ${kind}='int4' then hashtext(${key})::bigint else hashtextextended(${key},0) end as k) x`;
  keys.push({name,...row});
 }
 const keyOf=new Map(keys.map(k=>[`${k.classid}:${k.objid}`,k.name]));
 const holds=new Map<string,{lock:string;mode:string;pid:number;app:string;first:number;last:number;queries:string[]}>();
 let sampling=true;
 const loop=(async()=>{
  while(sampling){
   const rows=await obs<{pid:number;classid:string;objid:string;mode:string;xact:string;app:string;query:string}[]>`select l.pid,l.classid::text as classid,l.objid::text as objid,l.mode,
     a.xact_start::text as xact,coalesce(a.application_name,'') as app,left(regexp_replace(a.query,'\\s+',' ','g'),110) as query
    from pg_locks l join pg_stat_activity a on a.pid=l.pid
    where l.locktype='advisory' and l.granted and l.objsubid=1 and a.xact_start is not null
     and (l.classid::text||':'||l.objid::text)=any(${keys.map(k=>`${k.classid}:${k.objid}`)}::text[])`;
   const now=Date.now();
   for(const r of rows){
    const lock=keyOf.get(`${r.classid}:${r.objid}`)??'?';const id=`${r.pid}|${r.xact}|${lock}|${r.mode}`;
    const h=holds.get(id)??{lock,mode:r.mode,pid:r.pid,app:r.app,first:now,last:now,queries:[]};
    h.last=now;if(r.app)h.app=r.app;
    if(h.queries[h.queries.length-1]!==r.query&&h.queries.length<16)h.queries.push(r.query);
    holds.set(id,h);
   }
   await sleep(intervalMs);
  }
 })();
 return{
  async stop():Promise<TenantLockReport>{
   sampling=false;await loop;
   const all=[...holds.values()].map(h=>({lock:h.lock,mode:h.mode,pid:h.pid,app:h.app,ms:h.last-h.first,queries:h.queries}));
   const byLock:TenantLockReport['byLock']={};
   const byHolder:TenantLockReport['byHolder']={};
   for(const h of all){
    const b=byLock[h.lock]??={holds:0,maxMs:0,over1s:0};b.holds++;b.maxMs=Math.max(b.maxMs,h.ms);if(h.ms>1000)b.over1s++;
    const k=`${h.lock}|${h.app.startsWith('aihr-bulk:')?h.app:'other'}`;const c=byHolder[k]??={holds:0,maxMs:0,over1s:0};c.holds++;c.maxMs=Math.max(c.maxMs,h.ms);if(h.ms>1000)c.over1s++;
   }
   const byApp:TenantLockReport['byApp']={};const msByApp:Record<string,number[]>={};
   for(const h of all){const key=h.app||'(unlabelled)';const b=byApp[key]??={holds:0,maxMs:0,over1s:0,p95Ms:0};b.holds++;b.maxMs=Math.max(b.maxMs,h.ms);if(h.ms>1000)b.over1s++;(msByApp[key]??=[]).push(h.ms);}
   for(const [key,values] of Object.entries(msByApp)){values.sort((a,b)=>a-b);byApp[key].p95Ms=values[Math.floor(values.length*.95)]??0;}
   const sorted=all.sort((a,b)=>b.ms-a.ms);
   return{byLock,longest:sorted.slice(0,8),holds:sorted,byHolder,byApp};
  },
 };
}
