/** Compile-only full-native boundary controls. Nothing in this module is invoked.
 * The same complete file belongs to CONTROL and CANDIDATE; hosted whole TSC must
 * actually check it before compatibility can be claimed. No database is opened. */
import {drizzle} from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import {eq,sql} from 'drizzle-orm';
import {company,employment,person} from '../../db/schema';
import type {Db,Tx} from '../../db/client';

/** Actual old unannotated stock expression, not the proposed boundary as its own oracle. */
function originalNativeInference(pool:ReturnType<typeof postgres>){return drizzle(pool);}
type NativeDb=ReturnType<typeof originalNativeInference>;
type NativeTx=Parameters<Parameters<NativeDb['transaction']>[0]>[0];
type PublicShape<T>={[Key in keyof T]:T[Key]};
type DbKeysMatch=Exclude<keyof NativeDb,keyof Db>|Exclude<keyof Db,keyof NativeDb>;
type TxKeysMatch=Exclude<keyof NativeTx,keyof Tx>|Exclude<keyof Tx,keyof NativeTx>;
type PersonRow=typeof person.$inferSelect;
type JoinedRow={employmentId:string;companyName:string|null};
type Answer={answer:number};

/** Finite assignments preserve generic/overloaded native types without rebuilding a facade. */
export function databaseClientNativeContract(native:NativeDb,named:Db,nativeTx:NativeTx,tx:Tx){
 const dbToNamed:Db=native,dbToOriginal:NativeDb=named;
 const txToNamed:Tx=nativeTx,txToOriginal:NativeTx=tx;
 const dbKeys:DbKeysMatch extends never?true:false=true;
 const txKeys:TxKeysMatch extends never?true:false=true;
 const clientToOriginal:NativeDb['$client']=named.$client;
 const clientToNamed:Db['$client']=native.$client;
 const schemaToOriginal:NativeDb['_']=named._,schemaToNamed:Db['_']=native._;
 const txSchemaToOriginal:NativeTx['_']=tx._,txSchemaToNamed:Tx['_']=nativeTx._;
 const selectToOriginal:NativeDb['select']=named.select,selectToNamed:Db['select']=native.select;
 const executeToOriginal:NativeDb['execute']=named.execute,executeToNamed:Db['execute']=native.execute;
 const outerToOriginal:NativeDb['transaction']=named.transaction,outerToNamed:Db['transaction']=native.transaction;
 const nestedToOriginal:NativeTx['transaction']=tx.transaction,nestedToNamed:Tx['transaction']=nativeTx.transaction;
 const metadataToOriginal:NativeDb['query']=named.query,metadataToNamed:Db['query']=native.query;
 const nativeSqlResult=named.$client<{answer:number}[]>`select 1 as answer`;
 const nativeSqlRows:PromiseLike<Answer[]>=nativeSqlResult;
 return {dbToNamed,dbToOriginal,txToNamed,txToOriginal,dbKeys,txKeys,clientToOriginal,clientToNamed,
  schemaToOriginal,schemaToNamed,txSchemaToOriginal,txSchemaToNamed,selectToOriginal,selectToNamed,
  executeToOriginal,executeToNamed,outerToOriginal,outerToNamed,nestedToOriginal,nestedToNamed,
  metadataToOriginal,metadataToNamed,nativeSqlRows};
}

/** Row inference, joins, writes, CTEs, SQL and nested transactions stay real stock API calls. */
export async function databaseClientNativeInference(named:Db,tx:Tx,tenantId:string,personId:string){
 const all:PersonRow[]=await named.select().from(person);
 const partial:{id:string;fullName:string}[]=await named.select({id:person.id,fullName:person.fullName}).from(person);
 const joined:JoinedRow[]=await named.select({employmentId:employment.id,companyName:company.legalName})
  .from(employment).leftJoin(company,eq(employment.companyId,company.id));
 const distinct:{id:string}[]=await named.selectDistinct({id:person.id}).from(person);
 const distinctOn:{id:string}[]=await named.selectDistinctOn([person.id],{id:person.id}).from(person).orderBy(person.id);
 const inserted:{id:string}[]=await named.insert(person).values({tenantId,fullName:'Compile-only fictional identity',primaryEmail:'compile-only@example.invalid'}).returning({id:person.id});
 const updated:{id:string}[]=await named.update(person).set({fullName:'Compile-only fictional change'}).where(eq(person.id,personId)).returning({id:person.id});
 const deleted:{id:string}[]=await named.delete(person).where(eq(person.id,personId)).returning({id:person.id});
 const source=named.$with('compile_only_people').as(named.select({id:person.id}).from(person));
 const cte:{id:string}[]=await named.with(source).select({id:source.id}).from(source);
 const result:Answer[]=await named.execute<Answer>(sql`select 1 as answer`);
 const txRows:PersonRow[]=await tx.select().from(person).for('share');
 const txResult:Answer[]=await tx.execute<Answer>(sql`select 1 as answer`);
 const count:number=await named.$count(person);
 const transactionResult:string=await named.transaction(async admitted=>{
  const same:Tx=admitted;
  await same.setTransaction({isolationLevel:'repeatable read',accessMode:'read only'});
  const nested:number=await admitted.transaction(async child=>{
   const sameChild:Tx=child;
   const rows:{id:string}[]=await sameChild.select({id:person.id}).from(person);
   return rows.length;
  });
  return String(nested);
 },{isolationLevel:'read committed',accessMode:'read write',deferrable:false});
 const nestedResult:number=await tx.transaction(async child=>{
  const same:Tx=child;const rows:PersonRow[]=await same.select().from(person);return rows.length;
 });
 return {all,partial,joined,distinct,distinctOn,inserted,updated,deleted,cte,result,txRows,txResult,count,transactionResult,nestedResult};
}

/** Invalid inputs/results and erased protected ancestry must remain compiler errors. */
export async function databaseClientNativeRefusals(named:Db,tx:Tx,publicDb:PublicShape<NativeDb>&{authToken?:never},publicTx:PublicShape<NativeTx>){
 // @ts-expect-error A public replica declaring a public token cannot impersonate its native protected origin.
 const fakeDb:Db=publicDb;
 // @ts-expect-error A public-key replica cannot impersonate protected transaction ancestry.
 const fakeTx:Tx=publicTx;
 // @ts-expect-error Schema-free drizzle(client) does not invent relational schema registration.
 named.query.person.findMany();
 // @ts-expect-error A literal number is not a selected column or SQL expression.
 named.select({invalid:42});
 // @ts-expect-error SQL result rows retain the native record constraint.
 named.execute<number>(sql`select 1`);
 // @ts-expect-error Native execute row selection cannot become a string result.
 const wrongResult:string[]=await named.execute<Answer>(sql`select 1 as answer`);
 // @ts-expect-error Left-joined company remains nullable even with a non-null original column.
 const wrongJoin:{employmentId:string;companyName:string}[]=await named.select({employmentId:employment.id,companyName:company.legalName})
  .from(employment).leftJoin(company,eq(employment.companyId,company.id));
 // @ts-expect-error Invalid native isolation level is not accepted by a widened boundary.
 named.transaction(async()=>0,{isolationLevel:'read eventually'});
 // @ts-expect-error Native transaction callback result remains number.
 const wrongTransaction:string=await named.transaction(async()=>42);
 // @ts-expect-error Db cannot impersonate the transaction-only rollback operation.
 named.rollback();
 // @ts-expect-error Db does not gain the transaction-only mode setter.
 named.setTransaction({accessMode:'read only'});
 // @ts-expect-error Transaction mode retains the native closed grammar.
 tx.setTransaction({accessMode:'read mostly'});
 return {fakeDb,fakeTx,wrongResult,wrongJoin,wrongTransaction};
}

/** Exact never return is checked separately, without calling rollback in other controls. */
export function databaseClientNativeRollback(tx:Tx):never{return tx.rollback();}
