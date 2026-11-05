/** Exercises the exact unallocated SQL in a rollback-only, disposable hosted migration catalog. */
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {closeAll,migrateTestDb,owner} from '../harness';

const file='test/performance/personnel-profile-guard-proposal.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);
afterAll(closeAll);

it.skipIf(!requested)('verifies exact predecessor, refuses drift and preserves all metadata except the finite record body',async()=>{
 const report:Record<string,unknown>={kind:'UNALLOCATED_PROFILE_NATIVE_GUARD_WITNESS',releaseEligible:false};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-profile-guard-proposal.json'),JSON.stringify(report,null,2));
 const input=readFileSync(new URL('./personnel-profile-point-read.proposal.sql',import.meta.url),'utf8');
 const [guard,replacement]=input.split('--> statement-breakpoint');
 expect(input.split('--> statement-breakpoint')).toHaveLength(2);
 const catalog=`select p.oid::regprocedure::text as signature,md5(p.prosrc) as body_hash,
  p.proowner::regrole::text as owner,l.lanname as language,p.prosecdef as definer,p.proisstrict as strict,p.proleakproof as leakproof,
  p.provolatile as volatility,p.proparallel as parallel,p.procost as cost,p.prorows as rows,p.proretset as returns_set,
  p.proconfig as config,p.proacl::text as acl,p.proargnames as args,
  (select jsonb_agg(jsonb_build_object('grantee',case when a.grantee=0 then 'PUBLIC' else a.grantee::regrole::text end,
   'grantor',a.grantor::regrole::text,'privilege',a.privilege_type,'grantable',a.is_grantable) order by a.grantee)
   from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a) as acl_entries
  from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=any(array[
  'app.access_workforce_record(uuid)'::regprocedure,'app.access_workforce_editor(uuid)'::regprocedure,
  'app.assistant_workforce_profile_scope(uuid)'::regprocedure,'app.access_workforce_list_rows_for_ids(uuid[])'::regprocedure,
  'app._access_workforce_list_rows(uuid[])'::regprocedure]) order by p.oid`;
 const before=Array.from(await owner.client.unsafe(catalog));
 report.before=before;save();
 const aborted=new Error('rollback-only proof');
 try{
  await owner.client.begin(async tx=>{
   const drift=[
    ['target planner metadata','alter function app.access_workforce_record(uuid) cost 101'],
    ['public grant','grant execute on function app.access_workforce_record(uuid) to public'],
    ['private projection grant','grant execute on function app._access_workforce_list_rows(uuid[]) to ai_hr_app'],
   ] as const;
   for(const [label,sql] of drift){
    await expect(tx.savepoint(async sub=>{await sub.unsafe(sql);await sub.unsafe(guard);})).rejects.toMatchObject({code:'55000'});
    report.refused=[...((report.refused??[]) as string[]),label];save();
   }
   expect(Array.from(await tx.unsafe(catalog))).toEqual(before);
   await tx.unsafe(guard);
   await tx.unsafe(replacement);
   const after=Array.from(await tx.unsafe(catalog));
   report.after=after;save();
   expect(after).toEqual(before.map(row=>row.signature==='app.access_workforce_record(uuid)'
    ?{...row,body_hash:'e00f026bccde3ce1c8a085d5d3ba5ede'}:row));
   await expect(tx.savepoint(async sub=>{await sub.unsafe(guard);})).rejects.toMatchObject({code:'55000'});
   report.alreadyChangedPredecessorRefused=true;save();
   throw aborted;
  });
 }catch(error){if(error!==aborted)throw error;}
 finally{
  const restored=Array.from(await owner.client.unsafe(catalog));
  expect(restored).toEqual(before);
  report.rolledBackExactly=true;save();
 }
},120000);
