/** Transport regression uses the actual production queue-owner constructor, never createDb/drizzle on that pool. */
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {sql,eq} from 'drizzle-orm';
import {pgTable,uuid,date,jsonb} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {openImportWorkerOwner} from '../db/worker-connection';
import {withContractPostingTransaction} from '../core/contract-posting-transaction';
import {migrateTestDb,closeAll} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
const rows=pgTable('contract_posting_transport_fixture',{id:uuid().primaryKey(),day:date({mode:'string'}).notNull(),payload:jsonb().$type<{label:string;nested:{enabled:boolean;values:number[]}}>().notNull()});
const day='2026-02-28',payload={label:'Fictional {literal} JSON',nested:{enabled:true,values:[1,2,3]}};
const rawText='select $1::date as day,$2::jsonb as data';
const codecState=(owner:ReturnType<typeof openImportWorkerOwner>)=>({parsers:Object.getOwnPropertyDescriptors(owner.options.parsers),serializers:Object.getOwnPropertyDescriptors(owner.options.serializers)});
async function plainOwner(write:(owner:ReturnType<typeof openImportWorkerOwner>,connection:postgres.ReservedSql)=>Promise<void>){
 const owner=openImportWorkerOwner(process.env.TEST_MIGRATION_DATABASE_URL!);let connection:postgres.ReservedSql|undefined;
 try{connection=await owner.reserve();await connection`begin`;await write(owner,connection);}
 finally{try{if(connection){try{await connection`rollback`;}finally{connection.release();}}}finally{await owner.end({timeout:5});}}
}
it('uses real date/JSON codecs and savepoints on the reserved backend, then preserves raw cached query behavior',async()=>{
 await plainOwner(async(owner,connection)=>{
  await connection`create temporary table contract_posting_transport_fixture(id uuid primary key,day date not null,payload jsonb not null) on commit drop`;
  await connection`grant select,insert,update,delete on contract_posting_transport_fixture to ai_hr_app`;
  await connection`set local role ai_hr_app`;
  const[before]=await connection<{backend:number;xid:string;role:string}[]>`select pg_backend_pid() as backend,txid_current()::text as xid,current_user as role`;
  // Warm the SAME parameterized query in the raw driver's statement/column-parser cache.
  const[rawBefore]=await connection.unsafe<{day:Date;data:typeof payload}[]>(rawText,[day,payload],{prepare:true});expect(rawBefore.day).toBeInstanceOf(Date);expect(rawBefore.data).toEqual(payload);
  const saved=codecState(owner),id=randomUUID(),discard=randomUUID();
  await withContractPostingTransaction(owner,connection,async tx=>{
   const[witness]=await tx.execute<{backend:number;xid:string;role:string}>(sql`select pg_backend_pid() as backend,txid_current()::text as xid,current_user as role`);expect(witness).toEqual(before);
   await tx.insert(rows).values({id,day,payload});expect(await tx.select().from(rows).where(eq(rows.id,id))).toEqual([{id,day,payload}]);
   // The official column encoder supplies JSON once; prepare:false must bypass the warm raw parser.
   const[direct]=await tx.execute<{day:string;data:typeof payload}>(sql`select ${day}::date as day,${sql.param(payload,rows.payload)}::jsonb as data`);expect(direct).toEqual({day,data:payload});
   const probe=tx.select({day:rows.day,payload:rows.payload}).from(rows).where(eq(rows.id,id)).prepare('fictional_contract_native_codec_probe');expect(await probe.execute()).toEqual([{day,payload}]);
   await expect(tx.transaction(async child=>{
    const[inside]=await child.execute<{backend:number;xid:string;role:string}>(sql`select pg_backend_pid() as backend,txid_current()::text as xid,current_user as role`);expect(inside).toEqual(before);
    await child.insert(rows).values({id:discard,day:'2026-03-01',payload});child.rollback();
   })).rejects.toThrow();
   expect(await tx.select().from(rows).where(eq(rows.id,discard))).toEqual([]);
   await tx.transaction(async child=>{await child.update(rows).set({payload:{...payload,label:'Fictional committed savepoint'}}).where(eq(rows.id,id));});
   expect((await tx.select().from(rows).where(eq(rows.id,id)))[0].payload.label).toBe('Fictional committed savepoint');
   await expect(withContractPostingTransaction(owner,connection,async()=>undefined)).rejects.toThrow('already in use');
  });
  expect(codecState(owner)).toEqual(saved);
  const[rawAfter]=await connection.unsafe<{day:Date;data:typeof payload}[]>(rawText,[day,payload],{prepare:true});expect(rawAfter.day).toBeInstanceOf(Date);expect(rawAfter.day.toISOString()).toBe(rawBefore.day.toISOString());expect(rawAfter.data).toEqual(rawBefore.data);
  const[after]=await connection<{backend:number;xid:string;role:string}[]>`select pg_backend_pid() as backend,txid_current()::text as xid,current_user as role`;expect(after).toEqual(before);
  const[stored]=await connection<{kind:string;label:string}[]>`select jsonb_typeof(payload) as kind,payload->>'label' as label from contract_posting_transport_fixture where id=${id}`;expect(stored).toEqual({kind:'object',label:'Fictional committed savepoint'});
 });
},120000);
it('restores the actual plain owner codecs after callback and official factory failures',async()=>{
 await plainOwner(async(owner,connection)=>{
  const saved=codecState(owner),failure=new Error('Fictional owner write failed');
  await expect(withContractPostingTransaction(owner,connection,async()=>{throw failure;})).rejects.toBe(failure);expect(codecState(owner)).toEqual(saved);
  // Real constructor failure AFTER date codecs changed: a native options descriptor is read-only.
  const original=Object.getOwnPropertyDescriptor(owner.options.serializers,'114')!;
  Object.defineProperty(owner.options.serializers,'114',{...original,writable:false});const blocked=codecState(owner);
  try{await expect(withContractPostingTransaction(owner,connection,async()=>{throw Error('The callback must not run after constructor failure.');})).rejects.toBeInstanceOf(TypeError);expect(codecState(owner)).toEqual(blocked);}
  finally{Object.defineProperty(owner.options.serializers,'114',original);}
  expect(codecState(owner)).toEqual(saved);
  const[row]=await connection.unsafe<{day:Date;data:typeof payload}[]>(rawText,[day,payload],{prepare:true});expect(row.day).toBeInstanceOf(Date);expect(row.data).toEqual(payload);
  await withContractPostingTransaction(owner,connection,async tx=>{const[row]=await tx.execute<{ok:number}>(sql`select 1::integer as ok`);expect(row.ok).toBe(1);});expect(codecState(owner)).toEqual(saved);
 });
},120000);
it('refuses multi-connection owner codec changes and a missing enclosing transaction',async()=>{
 const multi=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:2,onnotice:()=>{}}),connection=await multi.reserve();
 try{const saved=codecState(multi);await expect(withContractPostingTransaction(multi,connection,async()=>undefined)).rejects.toThrow('single-connection');expect(codecState(multi)).toEqual(saved);}
 finally{connection.release();await multi.end({timeout:5});}
 const plain=openImportWorkerOwner(process.env.TEST_MIGRATION_DATABASE_URL!),reserved=await plain.reserve();
 try{const saved=codecState(plain);await expect(withContractPostingTransaction(plain,reserved,async()=>{throw Error('No transaction callback must run.');})).rejects.toThrow('existing reserved backend transaction');expect(codecState(plain)).toEqual(saved);}
 finally{reserved.release();await plain.end({timeout:5});}
},120000);
