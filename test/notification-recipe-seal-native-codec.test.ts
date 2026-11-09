/** Read-only native binary codec vectors only. No worker SQL/profile/install API. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {beforeEach,afterAll,expect,it,type TestContext} from 'vitest';
import postgres from 'postgres';
import {notificationRecipeSealBytes,notificationRecipeSealFormat,type NotificationRecipeSealRow} from '../lib/notification-worker/recipe-seal';
import {notificationWorkerProjectionContract,notificationWorkerAssessmentContract} from '../lib/notification-worker/projection';
import {notificationWorkerFixtureDatabase} from './fixtures/notification-worker/database';
import {notificationDiagnosticOwnership} from './fixtures/notification-worker/diagnostic-ownership';
const query=readFileSync('test/fixtures/notification-worker/recipe-seal-codec.sql','utf8'),ownership=notificationDiagnosticOwnership();
type NativeVector={valid:boolean;recipeCount:number;hex:string|null;byteLength:number|null;sha256:string|null};
const row:NotificationRecipeSealRow={eventType:'é',kind:'k',category:null,recipientPort:null,implemented:true,audience:'subject',guard:null};
beforeEach(()=>ownership.beforeCase());afterAll(()=>ownership.drain());
function owned(context:TestContext,work:(call:(value:unknown,version:2|3)=>Promise<NativeVector>)=>Promise<void>){
 return ownership.run(context,async()=>{
  const binding=notificationWorkerFixtureDatabase();assert.equal(binding.appUrl.username,'ai_hr_app');assert.equal(binding.appUrl.password,'');
  const connection=postgres(binding.appUrl.href,{max:1,connect_timeout:2,prepare:false,connection:{search_path:'pg_catalog, pg_temp',statement_timeout:'20s',lock_timeout:'300ms',default_transaction_isolation:'repeatable read',default_transaction_read_only:'on'}});
  let closing:Promise<void>|undefined,failed=false,failure:unknown;
  const close=()=>closing??=connection.end({timeout:0});
  const abort=()=>{void close().catch(()=>{});};
  context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();
  try{
   context.signal.throwIfAborted();
   await work(async(value,version)=>{
    context.signal.throwIfAborted();
    return connection.begin('isolation level repeatable read read only',async tx=>{
     const [identity]=await tx`select current_database()as database,session_user::text as session,current_user::text as current,current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')as readonly,current_setting('search_path')as search,current_setting('statement_timeout')as statement,current_setting('lock_timeout')as lock,inet_server_addr()='127.0.0.1'::inet as loopback`;
     expect(identity).toEqual({database:binding.database,session:'ai_hr_app',current:'ai_hr_app',isolation:'repeatable read',readonly:'on',search:'pg_catalog, pg_temp',statement:'20s',lock:'300ms',loopback:true});
     const serialized=JSON.stringify(value);assert(typeof serialized==='string','Representable JSON codec vector required');
     const [wire]=await tx`select jsonb_typeof(${serialized}::text::jsonb)as kind,case when jsonb_typeof(${serialized}::text::jsonb)='array'then jsonb_array_length(${serialized}::text::jsonb)end as count`;
     expect(wire).toEqual({kind:value===null?'null':Array.isArray(value)?'array':typeof value,count:Array.isArray(value)?value.length:null});context.signal.throwIfAborted();
     const [actual]=await tx.unsafe<NativeVector[]>(query,[serialized,version]);assert(actual);context.signal.throwIfAborted();return actual;
    });
   });
  }catch(error){failed=true;failure=error;}
  finally{
   try{await close();}
   catch(error){failure=failed?new AggregateError([failure,error],'Native codec and close refused'):error;failed=true;ownership.poison(error instanceof Error?error:Error('Native codec close refused'));}
   context.signal.removeEventListener('abort',abort);
  }
  if(context.signal.aborted){if(!failed)failure=context.signal.reason??Error('Native codec aborted');failed=true;}
  if(failed)throw failure;
 });
}
it('matches the literal native UTF8 frame and complete v2/v3 canonical source contracts',context=>owned(context,async call=>{
 for(const [input,version]of [[[row],2],[notificationWorkerProjectionContract,2],[notificationWorkerAssessmentContract,3]]as const){
  const js=notificationRecipeSealBytes(input,version),native=await call(input,version);
  expect(native).toEqual({valid:true,recipeCount:js.recipeCount,hex:js.bytes.toString('hex'),byteLength:js.byteLength,sha256:js.sha256});
  process.stdout.write(JSON.stringify({kind:'UNINSTALLED_RECIPE_CODEC_VECTOR',apiVersion:version,recipeCount:native.recipeCount,byteLength:native.byteLength,sha256:native.sha256,releaseAuthorized:false})+'\n');
 }
 expect((await call([row],2)).hex).toBe('414948525f4e4f54494649434154494f4e5f5245434950455f5345414c00000000010000000200000001525400000002c3a954000000016b4e4e5954000000077375626a6563744e');
}));
it('preserves exact native C ordering, Unicode and optional-not/null distinctions',context=>owned(context,async call=>{
 const input=[{...row,eventType:'😀'},{...row,eventType:'z'},{...row,eventType:'e\u0301'},{...row,eventType:'é'}];
 expect(await call(input,2)).toEqual(await call([...input].reverse(),2));
 const hashes=new Set<string|null>();
 for(const guard of [null,{field:'notify',equals:true},{field:'notify',equals:true,not:true},{field:'overtime',equals:true}]){
  const value=[{...row,guard}],native=await call(value,2),js=notificationRecipeSealBytes(value,2);expect(native.valid).toBe(true);expect(native.hex).toBe(js.bytes.toString('hex'));hashes.add(native.sha256);
 }
 expect(hashes.size).toBe(4);
}));
it('refuses unknown/missing/null/false guard metadata, wrong audience/port and duplicate identities natively',context=>owned(context,async call=>{
 const invalid=[[],null,{},[{}],[{...row,extra:1}],[{...row,audience:'reader'}],[{...row,recipientPort:'contract'}],[row,{...row,category:'review'}],
  ...[{field:'notify',equals:true,not:null},{field:'notify',equals:true,not:false},{field:'notify',equals:true,extra:1},{field:'notify'},{field:'other',equals:true}].map(guard=>[{...row,guard}])];
 invalid.push([{...row,eventType:'x'.repeat(notificationRecipeSealFormat.maximumBytes)}],Array.from({length:notificationRecipeSealFormat.maximumRows+1},(_,index)=>({...row,eventType:String(index)})));
 for(const value of invalid){expect(()=>notificationRecipeSealBytes(value,2)).toThrow();const native=await call(value,2);expect(native.valid).toBe(false);expect(native.hex).toBeNull();expect(native.sha256).toBeNull();expect(native.byteLength).toBeNull();}
 for(const version of [0,1,4,null])expect(await Reflect.apply(call,undefined,[[row],version])).toMatchObject({valid:false,hex:null,byteLength:null,sha256:null});
}));
