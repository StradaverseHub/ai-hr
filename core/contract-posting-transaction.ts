/** Official Drizzle transport over the fixed kernel's existing reserved transaction.
 * Only an exclusive max1 owner may lend its codecs. The caller retains BEGIN/COMMIT/ROLLBACK.
 * Raw kernel queries retain their original codec functions and prepared-column cache afterwards.
 */
import {sql} from 'drizzle-orm';
import {PgDialect,PgTransaction,type PgSession} from 'drizzle-orm/pg-core';
import {drizzle,type PostgresJsQueryResultHKT} from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import type {Tx} from '../db/client';
import {reservedSqlExecutor} from '../db/sql-executor';
import {withContractPostingSavepointSourceTx} from './contract-posting-history-source';

type NativeFullSchema=Tx['_']['fullSchema'];
type NativeRelationalSchema=NonNullable<Tx['_']['schema']>;
type SavepointState={next:number;active:boolean};
type NativeSession=PgSession<PostgresJsQueryResultHKT,NativeFullSchema,NativeRelationalSchema>;
const borrowedOwners=new WeakSet<postgres.Sql>();
type CodecSnapshot={target:object;before:Map<PropertyKey,PropertyDescriptor>;changed?:PropertyKey[]};
function snapshot(target:object):CodecSnapshot{return {target,before:new Map(Reflect.ownKeys(target).map(key=>[key,Object.getOwnPropertyDescriptor(target,key)!]))};}
function changedKeys(saved:CodecSnapshot):PropertyKey[]{
 return [...new Set([...saved.before.keys(),...Reflect.ownKeys(saved.target)])].filter(key=>{
  const before=saved.before.get(key),after=Object.getOwnPropertyDescriptor(saved.target,key);
  return !before||!after||before.value!==after.value||before.get!==after.get||before.set!==after.set||before.writable!==after.writable||before.enumerable!==after.enumerable||before.configurable!==after.configurable;
 });
}
function restore(snapshots:CodecSnapshot[]){
 const errors:unknown[]=[];
 for(const saved of snapshots)for(const key of saved.changed??changedKeys(saved))try{
  const before=saved.before.get(key);
  if(before)Object.defineProperty(saved.target,key,before);
  else if(!Reflect.deleteProperty(saved.target,key))throw Error('A Contract driver codec could not be restored.');
 }catch(error){errors.push(error);}
 if(errors.length)throw new AggregateError(errors,'Contract driver codec restoration failed; abort the owner transaction.');
}
class ContractPostingTransaction extends PgTransaction<PostgresJsQueryResultHKT,NativeFullSchema,NativeRelationalSchema>{
 constructor(private readonly nativeDialect:PgDialect,private readonly nativeSession:NativeSession,private readonly state:SavepointState){super(nativeDialect,nativeSession,undefined);}
 override async transaction<T>(write:(child:Tx)=>Promise<T>):Promise<T>{
  if(!this.state.active)throw Error('The Contract application transaction has ended.');
  const name=sql.identifier(`contract_posting_sp_${++this.state.next}`);
  await this.execute(sql`savepoint ${name}`);
  const child=new ContractPostingTransaction(this.nativeDialect,this.nativeSession,this.state);
  try{
   const result=await withContractPostingSavepointSourceTx(this,child,()=>write(child));
   await this.execute(sql`release savepoint ${name}`);return result;
  }catch(error){
   await this.execute(sql`rollback to savepoint ${name}`);
   await this.execute(sql`release savepoint ${name}`);throw error;
  }
 }
}

/** Fixed private kernel call only: ownerPool is the SAME max1 pool which reserved connection.
 * Do not lend this pool to concurrent raw work or leave an unawaited ORM query in write().
 * The two native witnesses refuse a different backend or a missing enclosing transaction.
 */
export async function withContractPostingTransaction<T>(ownerPool:postgres.Sql,connection:postgres.ReservedSql,write:(tx:Tx)=>Promise<T>):Promise<T>{
 if(ownerPool.options.max!==1)throw Error('Contract application requires its exclusive single-connection owner pool.');
 if(borrowedOwners.has(ownerPool))throw Error('The Contract owner driver is already in use; use its native savepoint transaction.');
 borrowedOwners.add(ownerPool);
 const state:SavepointState={next:0,active:true},saved=[snapshot(ownerPool.options.parsers),snapshot(ownerPool.options.serializers)];
 try{
  const[before]=await reservedSqlExecutor(connection).execute<{backend:number;transaction:string}>(sql`select pg_backend_pid() as backend,txid_current()::text as transaction`);
  // A callable proxy keeps the official driver surface. Only ORM unsafe queries change transport;
  // no parent query, connection, serializer or parser is reimplemented here.
  const unsafe:postgres.Sql['unsafe']=<Rows extends unknown[]>(text:string,parameters?:postgres.ParameterOrJSON<never>[],options?:postgres.UnsafeQueryOptions)=>{
   if(!state.active)throw Error('The Contract application transaction has ended.');
   return connection.unsafe<Rows>(text,parameters,{...options,prepare:false});
  };
  const transport=new Proxy(ownerPool,{get(target,key,receiver){return key==='unsafe'?unsafe:Reflect.get(target,key,receiver);}});
  const database=drizzle(transport); // Canonical0.45.2 codec configuration and actual native session.
  for(const entry of saved)entry.changed=changedKeys(entry);
  const tx=new ContractPostingTransaction(new PgDialect(),database._.session,state);
  const[witness]=await tx.execute<{backend:number;transaction:string}>(sql`select pg_backend_pid() as backend,txid_current()::text as transaction`);
  if(!before||witness?.backend!==before.backend||witness.transaction!==before.transaction)throw Error('Contract application must stay in the existing reserved backend transaction.');
  return await write(tx);
 }finally{
  state.active=false;
  try{restore(saved);}finally{borrowedOwners.delete(ownerPool);}
 }
}
