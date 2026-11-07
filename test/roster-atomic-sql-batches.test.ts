/** Native hosted qualification of statement batching, not a 100k-command capacity claim. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {domainEvent,employment,rosterAssignment} from '../db/schema';
import {assignShiftBulk,copyRoster,createShift,setRestDayBulk} from '../core/roster';
import {assertUniqueRosterWriteKeys,rosterUuidSet} from '../core/roster-write-batches';
import {hireEmployee} from '../core/org';
import {pgErrorChain,pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base,ctx:SessionContext,ids:string[],shiftId:string;
const dates=Array.from({length:365},(_,n)=>new Date(Date.UTC(2099,0,1+n)).toISOString().slice(0,10));
const modes=['assign','rest','copy'] as const;
type Mode=typeof modes[number];
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();ctx=adminCtx(b);ids=[];
 shiftId=(await createShift(ctx,{name:'Fictional bounded SQL shift',code:'BSQL',startTime:'09:00',endTime:'18:00',weeklyPattern:[1,2,3,4,5,6,7]})).id;
 for(let n=0;n<4;n++)ids.push((await hireEmployee(ctx,{person:{fullName:'Fictional bounded SQL employee '+n,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'})).employmentId);
});
async function rows(){return owner.db.select().from(rosterAssignment).where(eq(rosterAssignment.tenantId,b.tenantId)).orderBy(rosterAssignment.employmentId,rosterAssignment.shiftDate);}
async function events(){return owner.db.select().from(domainEvent).where(eq(domainEvent.tenantId,b.tenantId)).orderBy(domainEvent.id);}
async function prepare(mode:Mode){
 if(mode==='copy'){
  await assignShiftBulk(ctx,{employmentIds:ids,shiftDates:dates,shiftId});
  await owner.db.update(rosterAssignment).set({note:'Fictional original <& note'}).where(eq(rosterAssignment.tenantId,b.tenantId));
 }
}
function run(mode:Mode):Promise<unknown>{
 if(mode==='assign')return assignShiftBulk(ctx,{employmentIds:ids,shiftDates:dates,shiftId});
 if(mode==='rest')return setRestDayBulk(ctx,{employmentIds:ids,shiftDates:dates,forShiftId:shiftId});
 return copyRoster(ctx,{employmentIds:ids,sourceFrom:'2099-01-01',sourceTo:'2099-12-31',targetFrom:'2100-01-01'});
}
async function observed<T>(operation:()=>Promise<T>){
 const native=database.withTenant,identities:unknown[]=[],wire:{text:string;parameters:unknown[]}[]=[];
 const debug=database.client.options.debug;
 database.client.options.debug=(_connection:number,text:string,parameters:unknown[])=>{wire.push({text,parameters});};
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<R>(context:SessionContext,read:(tx:Tx)=>Promise<R>,options?:Parameters<typeof database.withTenant>[2])=>native(context,async tx=>{
  const [identity]=await tx.execute<{role:string;tenant:string;user:string;employment:boolean;roster:boolean}>(sql`select current_user as role,app.current_tenant_id() as tenant,app.current_user_id() as "user",row_security_active('employment'::regclass) as employment,row_security_active('roster_assignment'::regclass) as roster`);
  expect(identity).toEqual({role:'ai_hr_app',tenant:b.tenantId,user:b.adminUserId,employment:true,roster:true});identities.push(identity);
  return read(tx);
 },options));
 try{return {value:await operation(),wire,identities};}
 finally{spy.mockRestore();database.client.options.debug=debug;}
}

it.each(modes)('writes every %s row across the statement boundary with original audit cardinality',async mode=>{
 await prepare(mode);const beforeEvents=await events();
 const result=await observed(()=>run(mode));expect(result.identities.length).toBeGreaterThan(0);
 expect(result.value).toEqual(mode==='assign'?{assigned:1460}:mode==='rest'?{rested:1460}:{copied:1460,sourceRows:1460});
 const inserts=result.wire.filter(row=>/^insert into "roster_assignment"/i.test(row.text));
 expect(inserts.length).toBeGreaterThan(1);expect(inserts.every(row=>row.parameters.length<=65535)).toBe(true);
 const stored=await rows(),target=mode==='copy'?stored.filter(row=>row.shiftDate>='2100-01-01'):stored;
 const expectedDates=mode==='copy'?dates.map(date=>new Date(Date.parse(date+'T00:00:00Z')+365*86400000).toISOString().slice(0,10)):dates;
 expect(target).toHaveLength(1460);
 for(const id of ids){
  const own=target.filter(row=>row.employmentId===id);
  expect(own.map(row=>row.shiftDate)).toEqual(expectedDates);
  expect(own.every(row=>row.shiftId===(mode==='rest'?null:shiftId)&&row.isRestDay===(mode==='rest')&&row.note===(mode==='copy'?'Fictional original <& note':null))).toBe(true);
 }
 const newEvents=(await events()).filter(row=>!beforeEvents.some(previous=>previous.id===row.id));
 const eventType=mode==='assign'?'roster.bulk.assigned':mode==='rest'?'roster.bulk.rest-day.set':'roster.copied';
 expect(newEvents.filter(row=>row.eventType===eventType)).toHaveLength(1);
 expect(newEvents.filter(row=>row.eventType==='roster.manual-changes')).toHaveLength(4);
 const summary=newEvents.find(row=>row.eventType===eventType)!;
 expect(summary.payload).toMatchObject(mode==='copy'?{rows:1460,employmentScope:4,sourceFrom:'2099-01-01',sourceTo:'2099-12-31',targetFrom:'2100-01-01',offsetDays:365}:{rows:1460,employmentCount:4,dateCount:365,shiftId});
 // Repeating updates every existing row; one logical command must use one timestamp
 // even though different SQL statements perform its conflict updates.
 await run(mode);const repeated=await rows(),updated=mode==='copy'?repeated.filter(row=>row.shiftDate>='2100-01-01'):repeated;
 expect(new Set(updated.map(row=>row.updatedAt.getTime())).size).toBe(1);
},300000);

it.each(modes)('rolls back earlier %s SQL chunks and all audits after an actual later-chunk database refusal',async mode=>{
 await prepare(mode);const beforeRows=await rows(),beforeEvents=await events();
 // This disposable trigger observes the first1,000 newly written target rows
 // before refusing a later chunk; it never changes a production migration.
 const target=mode==='copy'?"r.shift_date>=date '2100-01-01'":mode==='rest'?'r.is_rest_day':'true';
 await owner.db.execute(sql.raw(`create function app.fictional_roster_later_chunk_failure() returns trigger language plpgsql as $$begin if exists(select 1 from public.roster_assignment r where r.tenant_id=NEW.tenant_id and (${target}) offset 999 limit 1) then raise exception 'Fictional roster batch failure after 1000 rows' using errcode='23514';end if;return NEW;end$$`));
 await owner.db.execute(sql`create trigger fictional_roster_later_chunk_failure before insert or update on public.roster_assignment for each row execute function app.fictional_roster_later_chunk_failure()`);
 try{
  const observation=await observed(async()=>{try{await run(mode);return undefined;}catch(error){return error;}});
  const failure=observation.value;
  expect(observation.wire.filter(row=>/^insert into "roster_assignment"/i.test(row.text)).length).toBeGreaterThan(1);
  expect(pgSqlState(failure)).toBe('23514');
  expect(pgErrorChain(failure).some(error=>error.message==='Fictional roster batch failure after 1000 rows')).toBe(true);
  expect(await rows()).toEqual(beforeRows);expect(await events()).toEqual(beforeEvents);
 }finally{
  await owner.db.execute(sql`drop trigger fictional_roster_later_chunk_failure on public.roster_assignment`);
  await owner.db.execute(sql`drop function app.fictional_roster_later_chunk_failure()`);
 }
},300000);

it.each(['assign','rest'] as const)('preserves whole-command duplicate refusal beyond the %s chunk boundary',async mode=>{
 const repeatedIds=[...ids,ids[0]],beforeRows=await rows(),beforeEvents=await events();
 const operation=()=>mode==='assign'?assignShiftBulk(ctx,{employmentIds:repeatedIds,shiftDates:dates,shiftId}):setRestDayBulk(ctx,{employmentIds:repeatedIds,shiftDates:dates,forShiftId:shiftId});
 let failure:unknown;try{await operation();}catch(error){failure=error;}
 expect(pgSqlState(failure)).toBe('21000');expect(await rows()).toEqual(beforeRows);expect(await events()).toEqual(beforeEvents);
},300000);

it('proves the predecessor statement would exceed protocol arity without claiming that many advisory locks fit',async()=>{
 const hypothetical=Array.from({length:40},()=>randomUUID()).flatMap(employmentId=>dates.map(shiftDate=>({tenantId:b.tenantId,employmentId,shiftDate,shiftId,isRestDay:false})));
 const query=owner.db.insert(rosterAssignment).values(hypothetical).onConflictDoUpdate({target:[rosterAssignment.tenantId,rosterAssignment.employmentId,rosterAssignment.shiftDate],set:{shiftId:sql`excluded.shift_id`,isRestDay:false,updatedAt:new Date()}}).toSQL();
 expect(hypothetical).toHaveLength(14600);expect(query.params.length).toBeGreaterThan(65535);
 // Compilation only: executing14,600 day locks would conflate SQL arity with
 // the independent, still-unqualified shared advisory-lock capacity.
});

it('refuses cross-boundary physical duplicates in accepted UUID spellings without writing',async()=>{
 const separated=ids[0].replace(/-/g,'').match(/.{4}/g)!.join('-');
 const values=ids.flatMap(employmentId=>dates.map(shiftDate=>({employmentId,shiftDate})));
 for(const alias of [ids[0].toUpperCase(),'{'+ids[0]+'}',ids[0].replace(/-/g,''),separated]){
  const duplicated=[...values,{employmentId:alias,shiftDate:dates[0]}];
  let failure:unknown;try{assertUniqueRosterWriteKeys(duplicated);}catch(error){failure=error;}
  expect(pgSqlState(failure)).toBe('21000');
 }
 const beforeRows=await rows(),beforeEvents=await events();
 // The canonical native Duty admission can refuse aliased duplicate caller IDs
 // even earlier; retain that refusal rather than replacing it with a write.
 await expect(assignShiftBulk(ctx,{employmentIds:[...ids,'{'+ids[0].toUpperCase()+'}'],shiftDates:dates,shiftId})).rejects.toThrow();
 expect(await rows()).toEqual(beforeRows);expect(await events()).toEqual(beforeEvents);
},300000);

it('uses one fully parsed UUID array, preserves native UUID spellings and refuses malformed members even for empty populations',async()=>{
 const previousDebug=database.client.options.debug,wire:{text:string;parameters:unknown[];types:unknown[]}[]=[];
 // postgres.js populates this types array from PostgreSQL's ParameterDescription
 // before Bind. Keep the reference so the assertion sees the actual server OID.
 database.client.options.debug=(_connection:number,text:string,parameters:unknown[],types:unknown[])=>{wire.push({text,parameters,types});};
 try{
 const native=async(values:string[],empty=false)=>database.withTenant(ctx,async tx=>{
  const query=tx.select({id:employment.id}).from(employment).where(and(rosterUuidSet(employment.id,values),empty?eq(employment.companyId,randomUUID()):undefined));
  const compiled=query.toSQL();expect(compiled.sql).toContain('::uuid[]');expect(compiled.params).toHaveLength(empty?2:1);
  return query;
 });
 const separated=ids[0].replace(/-/g,'').match(/.{4}/g)!.join('-');
 for(const spelling of [ids[0],ids[0].toUpperCase(),'{'+ids[0]+'}',ids[0].replace(/-/g,''),separated])expect(await native([spelling])).toEqual([{id:ids[0]}]);
 expect(await native([])).toEqual([]);
 for(const invalid of ['not-a-uuid',ids[0]+','+ids[1],ids[0]+'"',ids[0]+'\\','NULL']){
  for(const empty of [false,true]){
   let failure:unknown;try{await native([ids[0],invalid],empty);}catch(error){failure=error;}
   expect(pgSqlState(failure),invalid+' / empty='+empty).toBe('22P02');
  }
 }
 // A valid foreign ID remains subject to the original native employment policy.
 const foreign=await seedBase();
 const hired=await hireEmployee(adminCtx(foreign),{person:{fullName:'Fictional foreign batch member',primaryEmail:randomUUID()+'@example.invalid'},companyId:foreign.companyId,departmentId:foreign.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 expect(await native([hired.employmentId])).toEqual([]);
 const boundArrays=wire.filter(row=>row.text.includes('"employment"."id"=any(')&&row.text.includes('::uuid[]'));
 expect(boundArrays.length).toBeGreaterThan(0);
 expect(boundArrays.some(row=>row.types[0]===2951&&typeof row.parameters[0]==='string')).toBe(true);
 }finally{database.client.options.debug=previousDebug;}
});
