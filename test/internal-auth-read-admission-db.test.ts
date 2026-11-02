/** Native pool admission ordering, not a wall-clock speed test or a substitute for500-user load. */
import {writeFileSync} from 'node:fs';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
const previousPool=vi.hoisted(()=>{const previous=process.env.AIHR_DB_POOL_MAX;process.env.AIHR_DB_POOL_MAX='1';return previous;});
import {generate} from 'otplib';
import {client} from '../db/client';
import {bootstrapInternalOwner} from '../lib/internal-auth/bootstrap';
import {digest} from '../lib/internal-auth/crypto';
import {passwordPolicyKey} from '../lib/password-policy';
import {readRecord,writeRecord} from '../lib/internal-auth/store';
import {forgetIdleTimeout} from '../lib/session-policy-server';
import {changeInitialPassword,readSession,startLogin,verifyMfa,type AuthReply} from '../lib/internal-auth/service';
import {closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();});
afterAll(async()=>{await closeAll();if(previousPool===undefined)delete process.env.AIHR_DB_POOL_MAX;else process.env.AIHR_DB_POOL_MAX=previousPool;});
const challenge=(reply:AuthReply)=>{if(!('challenge'in reply))throw Error('Expected native challenge');return reply.challenge;};
type NativeRows=Record<string,unknown>[];
type NativeWire={unsafe:(text:string,parameters?:unknown[])=>PromiseLike<NativeRows>};
type Reserved=NativeWire&{release:()=>void};
type Pool=NativeWire&{reserve:()=>Promise<Reserved>;options:{max:number}};
async function fixture(){
 await resetDb();const b=await seedBase();
 vi.stubEnv('AUTH_PROVIDER','internal');vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://hr.test');vi.stubEnv('AUTH_SESSION_KEY','9'.repeat(64));vi.stubEnv('AUTH_DEFAULT_ORGANIZATION','alpha');
 vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('No external HTTP in the native auth admission fixture.');}));
 await bootstrapInternalOwner(owner.client,{appUserId:b.adminUserId,organization:'alpha',username:'owner',email:'owner@example.test',password:'Temporary private passphrase 722!',installationOperator:true});
 const login=await startLogin({organization:'alpha',username:'owner',password:'Temporary private passphrase 722!',native:false});
 const setup=await changeInitialPassword(challenge(login),'A brand new secret phrase 933!',false);if(setup.step!=='enroll'||!setup.secret)throw Error('Expected MFA enrollment');
 const signedIn=await verifyMfa(challenge(setup),await generate({secret:setup.secret}),false);if(signedIn.step!=='complete')throw Error('Expected a complete browser session');
 const expected=await readSession(signedIn.access_token);expect(expected?.credential.tenantId).toBe(b.tenantId);
 return {b,signedIn,expected};
}
it('finishes fresh authentication SQL before a competing caller takes the sole pooled slot',async()=>{
 const {b,signedIn,expected}=await fixture();
 const pool=client as unknown as Pool;expect(pool.options.max).toBe(1);
 const originalUnsafe=pool.unsafe.bind(pool),originalReserve=pool.reserve.bind(pool);
 const sessionKey='session:'+digest(signedIn.access_token),trace:string[]=[];
 let competitor:Promise<Reserved>|undefined,reading:ReturnType<typeof readSession>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 let proof!:()=>void,interleaved!:()=>void;
 const proofReady=new Promise<'proof'>(resolve=>{proof=()=>resolve('proof');});
 const competitorReady=new Promise<'interleaved'>(resolve=>{interleaved=()=>resolve('interleaved');});
 const observe=async(text:string,parameters:unknown[]|undefined,pending:PromiseLike<NativeRows>)=>{
  const result=await pending;
  if(text==='select sealed from app.internal_auth_read($1,$2)'){
   const key=parameters?.[0];
   if(key===sessionKey&&!competitor){trace.push('session');competitor=originalReserve().then(connection=>{trace.push('competing-slot');interleaved();return connection;});}
   else if(key===passwordPolicyKey(b.tenantId)){trace.push('password-policy');proof();}
   else if(typeof key==='string'&&key.startsWith('credential:'))trace.push('credential');
   else if(typeof key==='string'&&key.startsWith('family:'))trace.push('family');
  }else if(text==='select app_user_id,tenant_id from app.principal_by_identity($1,$2)')trace.push('eligibility');
  return result;
 };
 vi.spyOn(pool,'unsafe').mockImplementation((text,parameters)=>observe(text,parameters,originalUnsafe(text,parameters)));
 vi.spyOn(pool,'reserve').mockImplementation(async()=>{
  const connection=await originalReserve(),unsafe=connection.unsafe.bind(connection);
  return new Proxy(connection,{get(target,key){return key==='unsafe'?(text:string,parameters?:unknown[])=>observe(text,parameters,unsafe(text,parameters)):Reflect.get(target,key);}});
 });
 let winner:string|undefined;
 try{
  reading=readSession(signedIn.access_token);
  winner=await Promise.race([proofReady,competitorReady,reading.then(()=> 'read-finished',()=> 'read-failed'),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Native admission probe did not reach either gate')),5000);})]);
 }finally{
  if(timer)clearTimeout(timer);
  // Both original and repaired readers must finish, and the real rival slot is always released.
  if(competitor)await competitor.then(connection=>connection.release());
  if(reading){const actual=await reading;expect(actual?.subject).toBe(expected?.subject);expect(actual?.issuer).toBe(expected?.issuer);}
  vi.restoreAllMocks();
 }
 expect(trace.filter(value=>value==='session')).toHaveLength(1);expect(trace.filter(value=>value==='credential')).toHaveLength(1);expect(trace.filter(value=>value==='family')).toHaveLength(1);expect(trace.filter(value=>value==='eligibility')).toHaveLength(1);expect(trace.filter(value=>value==='password-policy')).toHaveLength(1);
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/internal-auth-admission.json',JSON.stringify({kind:'NATIVE_ORDERING_NOT_SPEED_TARGET',poolMax:pool.options.max,winner,trace,identityPreserved:true}));
 expect(winner).toBe('proof');
},30000);

/** Keep native SQL and the real reserved connection; only the explicit failure/interleaving is controlled. */
function intercept(run:(wire:NativeWire['unsafe'],text:string,parameters?:unknown[])=>PromiseLike<NativeRows>){
 const pool=client as unknown as Pool,unsafe=pool.unsafe.bind(pool),reserve=pool.reserve.bind(pool);
 vi.spyOn(pool,'unsafe').mockImplementation((text,parameters)=>run(unsafe,text,parameters));
 vi.spyOn(pool,'reserve').mockImplementation(async()=>{
  const connection=await reserve(),reservedUnsafe=connection.unsafe.bind(connection);
  return new Proxy(connection,{get(target,key){return key==='unsafe'?(text:string,parameters?:unknown[])=>run(reservedUnsafe,text,parameters):Reflect.get(target,key);}});
 });
}
it('observes native account revocation after the session read and releases the slot on denial',async()=>{
 const {b,signedIn,expected}=await fixture(),key='session:'+digest(signedIn.access_token);let revoked=false;
 intercept(async(wire,text,parameters)=>{
  const result=await wire(text,parameters);
  if(!revoked&&text==='select sealed from app.internal_auth_read($1,$2)'&&parameters?.[0]===key){revoked=true;await owner.client`update app_user set archived_at=now()where id=${b.adminUserId}::uuid`;}
  return result;
 });
 try{expect(await readSession(signedIn.access_token)).toBeNull();expect(revoked).toBe(true);}
 finally{vi.restoreAllMocks();await owner.client`update app_user set archived_at=null where id=${b.adminUserId}::uuid`;}
 expect((await readSession(signedIn.access_token))?.subject).toBe(expected?.subject);
},30000);
it('propagates actual APP SQL failure and releases the reserved slot before the next reader',async()=>{
 const {signedIn,expected}=await fixture();let injected=false;
 intercept((wire,text,parameters)=>{
  if(!injected&&text==='select sealed from app.internal_auth_read($1,$2)'&&String(parameters?.[0]).startsWith('credential:')){injected=true;return wire('select 1/0');}
  return wire(text,parameters);
 });
 try{await expect(readSession(signedIn.access_token)).rejects.toMatchObject({code:'22012'});expect(injected).toBe(true);}
 finally{vi.restoreAllMocks();}
 expect((await readSession(signedIn.access_token))?.subject).toBe(expected?.subject);
},30000);
it('releases before cold idle-policy lookup and legacy-session initialization need the sole connection',async()=>{
 const {b,signedIn,expected}=await fixture(),key='session:'+digest(signedIn.access_token);
 const stored=await readRecord<{subject:string;absoluteExpiry:number;lastActivity?:number}>(client,key);expect(stored).toBeTruthy();
 const {lastActivity:omitted,...legacy}=stored!;expect(omitted).toBeTypeOf('number');
 await writeRecord(client,key,legacy,legacy.subject,legacy.absoluteExpiry);forgetIdleTimeout(b.tenantId);
 expect((await readSession(signedIn.access_token))?.subject).toBe(expected?.subject);
 const initialized=await readRecord<{lastActivity:number}>(client,key);expect(initialized?.lastActivity).toBeTypeOf('number');
},30000);
