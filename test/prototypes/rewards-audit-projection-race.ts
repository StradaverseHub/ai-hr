/** Owner-only native synchronization instrumentation. UNINSTALLED, no application API. */
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import {owner} from '../harness';
import {pgSqlState} from '../../lib/db-error';
import type {RewardsAuditFixtureOwner} from './rewards-audited-read-owner';
const signature='reward_audit_projection.materialize(integer)';
const checkpoint='public.reward_audit_projection_checkpoint(uuid)';
const recheck="  -- The cursor snapshot can predate another projector's COMMIT while receipt\n  -- tuples stay immutable. Once this row is locked, a NEW RC statement must\n  -- recheck the committed link before appending its unique event.\n  IF EXISTS(SELECT 1 FROM reward_audit_private.projection p WHERE p.receipt_id=r.id)THEN CONTINUE;END IF;\n";
const sqlSource=readFileSync('test/prototypes/rewards-audited-read.sql','utf8');
const fixedBody=sqlSource.slice(sqlSource.indexOf('CREATE FUNCTION reward_audit_projection.materialize')).split('AS $body$')[1].split('$body$;')[0];
const md5=(text:string)=>createHash('md5').update(text).digest('hex');
if(md5(fixedBody)!=='4963dbd09d8ed17b35521600cac4fe06'||fixedBody.split(recheck).length!==2)throw Error('Exact fixed native projector owner required');
const oldBody=fixedBody.replace(recheck,'');
if(md5(oldBody)!=='f313c19ebaa565960dfe32ababc092d6')throw Error('Exact frozen9e projector counterexample required');
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
async function definition(){const [row]=await owner.client`select pg_get_functiondef(p.oid)as definition,p.prosrc as body,to_jsonb(p)as details from pg_proc p where p.oid=${signature}::regprocedure`;return row;}
async function replaceOwned(expected:Awaited<ReturnType<typeof definition>>,body:string){
 if(expected.definition.split(expected.body).length!==2)throw Error('Exact single native function body boundary required');
 let next:Awaited<ReturnType<typeof definition>>|undefined;
 await owner.client.begin(async tx=>{
  await tx`set local statement_timeout='20s'`;await tx`set local lock_timeout='300ms'`;
  const [before]=await tx`select to_jsonb(p)as details,c.details as sealed from pg_proc p join reward_audit_private.function_contract c on c.signature=p.oid where p.oid=${signature}::regprocedure for update of c`;
  expect(before).toEqual({details:expected.details,sealed:expected.details});
  await tx.unsafe(expected.definition.replace(expected.body,body));
  const [changed]=await tx`select pg_get_functiondef(p.oid)as definition,p.prosrc as body,to_jsonb(p)as details from pg_proc p where p.oid=${signature}::regprocedure`;
  expect(changed.body).toBe(body);
  expect((await tx`select to_jsonb(p)-'prosrc' as details from pg_proc p where p.oid=${signature}::regprocedure`)[0].details).toEqual(Object.fromEntries(Object.entries(expected.details).filter(([name])=>name!=='prosrc')));
  const rows=await tx`update reward_audit_private.function_contract c set details=to_jsonb(p)from pg_proc p where p.oid=c.signature and p.oid=${signature}::regprocedure and c.details=${JSON.stringify(expected.details)}::text::jsonb returning c.signature`;
  expect(rows).toHaveLength(1);next=changed;
 });
 if(!next)throw Error('Owned native checkpoint binding did not settle');return next;
}
export async function rewardAuditProjectionRace(fixture:RewardsAuditFixtureOwner,receipt:string,variant:'frozen9e'|'fixed',signal:AbortSignal){
 signal.throwIfAborted();expect(receipt).toMatch(/^[0-9a-f-]{36}$/);await owner.client`select reward_audit_private.assert_profile()`;
 const original=await definition();expect(original.body).toBe(fixedBody);
 expect((await owner.client`select to_regprocedure(${checkpoint})as id`)[0].id).toBeNull();
 const a=fixture.connect('projector'),b=fixture.connect('projector');
 const [identity]=await a`select pg_backend_pid()as pid,backend_start::text as started,session_user,current_user,current_setting('transaction_isolation')as isolation,current_setting('statement_timeout')as statement,current_setting('lock_timeout')as lock from pg_stat_activity where pid=pg_backend_pid()`;
 expect(identity).toMatchObject({session_user:'ai_hr_reward_audit_projector',current_user:'ai_hr_reward_audit_projector',isolation:'read committed',statement:'20s',lock:'300ms'});
 expect(identity.pid).toBeGreaterThan(0);
 const [other]=await b`select pg_backend_pid()as pid,backend_start::text as started,session_user from pg_stat_activity where pid=pg_backend_pid()`;
 expect(other.session_user).toBe('ai_hr_reward_audit_projector');expect(other.pid).not.toBe(identity.pid);
 const releaseKey=BigInt('0x'+randomUUID().replace(/-/g,'').slice(0,12)).toString(),markerKey=(BigInt(releaseKey)+BigInt(1)).toString();
 const ready=deferred(),release=deferred();let held:Promise<unknown>|undefined,pending:Promise<{rows?:number;error?:unknown}>|undefined,ownedFunction:Awaited<ReturnType<typeof definition>>|undefined,gate:unknown;
 let stopping:Promise<unknown>=Promise.resolve();
 const abort=()=>{release.resolve();stopping=Promise.allSettled([a.end({timeout:0}),b.end({timeout:0})]);};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 try{
  const [ddl]=await owner.client`select format($ddl$CREATE FUNCTION public.reward_audit_projection_checkpoint(p_receipt uuid)RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $gate$
DECLARE until_at timestamptz:=clock_timestamp()+interval '5 seconds';
BEGIN
 IF p_receipt=%L::uuid AND pg_backend_pid()=%s AND (SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid())=%L::timestamptz THEN
  PERFORM pg_advisory_xact_lock(%L::bigint);
  WHILE NOT pg_try_advisory_xact_lock(%L::bigint) LOOP
   IF clock_timestamp()>until_at THEN RAISE EXCEPTION 'Owned snapshot checkpoint deadline' USING ERRCODE='57014';END IF;
   PERFORM pg_sleep(0.002);
  END LOOP;
 END IF;RETURN true;
END $gate$$ddl$,${receipt}::text,${identity.pid}::integer,${identity.started}::text,${markerKey}::text,${releaseKey}::text)as source`;
  await owner.client.unsafe(ddl.source);
  gate=(await owner.client`select to_jsonb(p)as details from pg_proc p where p.oid=${checkpoint}::regprocedure`)[0].details;
  await owner.client`revoke all on function public.reward_audit_projection_checkpoint(uuid)from public,ai_hr_app,ai_hr_reward_audit_read,ai_hr_reward_audit_projector`;
  const [created]=await owner.client`select to_jsonb(p)as details from pg_proc p where p.oid=${checkpoint}::regprocedure`;gate=created.details;
  expect((await owner.client`select p.prosecdef,p.proowner=(select relowner from pg_class where oid='public.domain_event'::regclass)as native_owner,
   has_function_privilege('ai_hr_app',p.oid,'EXECUTE')as app,has_function_privilege('ai_hr_reward_audit_read',p.oid,'EXECUTE')as reader,has_function_privilege('ai_hr_reward_audit_projector',p.oid,'EXECUTE')as projector,
   exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))x where x.grantee=0)as public_exec from pg_proc p where p.oid=${checkpoint}::regprocedure`)[0]).toEqual({prosecdef:false,native_owner:true,app:false,reader:false,projector:false,public_exec:false});
  const body=(variant==='frozen9e'?oldBody:fixedBody).replace('ORDER BY x.observed_at,x.id FOR UPDATE OF x SKIP LOCKED LIMIT p_limit LOOP','AND public.reward_audit_projection_checkpoint(x.id) ORDER BY x.observed_at,x.id FOR UPDATE OF x SKIP LOCKED LIMIT p_limit LOOP');
  ownedFunction=await replaceOwned(original,body);await owner.client`select reward_audit_private.assert_profile()`;
  held=owner.client.begin(async tx=>{await tx`set local statement_timeout='20s'`;await tx`set local lock_timeout='300ms'`;await tx`select pg_advisory_xact_lock(${releaseKey}::bigint)`;ready.resolve();await release.promise;});void held.catch(()=>{});
  await Promise.race([ready.promise,held.then(()=>{throw Error('Owned checkpoint holder exited before admission');})]);signal.throwIfAborted();
  pending=a<{projected:number}[]>`select reward_audit_projection.materialize(1)as projected`.then(rows=>({rows:rows[0].projected}),(error:unknown)=>({error}));
  let entered=false;
  for(let attempt=0;attempt<300;attempt++){
   signal.throwIfAborted();
   const [actual]=await owner.client`select exists(select 1 from pg_locks l join pg_stat_activity s on s.pid=l.pid where l.pid=${identity.pid} and s.backend_start=${identity.started}::text::timestamptz and s.usename='ai_hr_reward_audit_projector'and l.locktype='advisory'and l.granted and l.objsubid=1 and l.classid=((${markerKey}::bigint>>32)&4294967295)::oid and l.objid=(${markerKey}::bigint&4294967295)::oid)as entered`;
   if(actual.entered){entered=true;break;}await new Promise(resolve=>setTimeout(resolve,5));
  }
  expect(entered,'actual A entered the cursor snapshot before its receipt tuple lock').toBe(true);
  expect((await b<{projected:number}[]>`select reward_audit_projection.materialize(1)as projected`)[0].projected,'B locks the same receipt and really commits while A is paused').toBe(1);
  expect((await owner.client`select (select count(*)::int from reward_audit_private.projection where receipt_id=${receipt}::uuid)as links,(select count(*)::int from public.domain_event e join reward_audit_private.receipt r on r.event_id=e.id where r.id=${receipt}::uuid)as events`)[0]).toEqual({links:1,events:1});
  release.resolve();await held;const settled=await pending;
  if(variant==='frozen9e'){
   expect(pgSqlState(settled.error),'the real prior stale cursor tries the duplicate immutable event').toBe('23505');
   if(!settled.error||typeof settled.error!=='object')throw Error('Actual native duplicate-event refusal required');
   const [primary]=await owner.client`select conname from pg_constraint where conrelid='public.domain_event'::regclass and contype='p'`;
   expect(Reflect.get(settled.error,'table_name')).toBe('domain_event');expect(Reflect.get(settled.error,'constraint_name')).toBe(primary.conname);
  }else expect(settled,'fresh statement sees B committed link and emits nothing twice').toEqual({rows:0});
  signal.throwIfAborted();
 }finally{
  release.resolve();
  try{
   const drained=await Promise.allSettled([pending,held,stopping]);await Promise.all([a.end({timeout:0}),b.end({timeout:0})]);
   let absent=false;
   for(let attempt=0;attempt<200;attempt++){
    const [active]=await owner.client`select count(*)::int as n from pg_stat_activity where(pid=${identity.pid} and backend_start=${identity.started}::text::timestamptz)or(pid=${other.pid} and backend_start=${other.started}::text::timestamptz)`;
    if(active.n===0){absent=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
   }
   expect(absent,'both exact native backends settled before any profile restoration').toBe(true);
   if(ownedFunction){await replaceOwned(ownedFunction,original.body);expect(await definition()).toEqual(original);}
   if(gate){expect((await owner.client`select to_jsonb(p)as details from pg_proc p where p.oid=${checkpoint}::regprocedure`)[0].details).toEqual(gate);await owner.client`drop function public.reward_audit_projection_checkpoint(uuid)`;}
   await owner.client`select reward_audit_private.assert_profile()`;
   for(const item of drained)if(item.status==='rejected')throw item.reason;
  }finally{signal.removeEventListener('abort',abort);}
 }
}
