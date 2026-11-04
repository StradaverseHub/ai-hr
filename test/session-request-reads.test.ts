/** AI Centre navigation speed (4 November 2026): one request resolves the signed-in person's reads once, whichever session
 * carrier asks (lib/session.ts). Ask's page calls getSession while its layout and the launcher's server actions called
 * during the render call getBrowserCommandSession, so one Ask render read the principal and the login block twice.
 *
 * Through the real resolver on the dev identity path (the one the CI fixture can drive), with the pool replaced by a
 * stub that records each statement and React's per-request `cache` stood in by a memo that lives for one request (outside
 * a request scope `cache` is a passthrough, which is also tested):
 *  1. in one request both carriers share the principal and login-block reads, and each still gets its own session;
 *  2. outside a request every call reads afresh, exactly as before;
 *  3. each carrier keeps its own rules: an unknown selected identity self-heals to DEV_USER_ID for getSession and is
 *     refused for the command carrier, and a blocked one is refused by both;
 *  4. a failed read is not kept: the next carrier reads again.
 * No database: the statements are fictional rows. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({scope:null as null|Map<unknown,Map<string,unknown>>,cookie:undefined as string|undefined}));
const db=vi.hoisted(()=>({calls:[] as string[],principals:new Map<string,unknown>(),blocked:new Set<string>(),failPrincipal:0,failSnapshot:0}));
// One request's scope: `cache` memoises by function and argument until the request ends; with no scope it is a passthrough.
vi.mock('react',async importOriginal=>{
 const actual=await importOriginal<typeof import('react')>();
 const cache=<A extends unknown[],R>(fn:(...args:A)=>R)=>(...args:A):R=>{
  if(!state.scope)return fn(...args);
  let memo=state.scope.get(fn);if(!memo)state.scope.set(fn,memo=new Map());
  const key=JSON.stringify(args);if(!memo.has(key))memo.set(key,fn(...args));return memo.get(key) as R;
 };
 return {...actual,default:{...actual,cache},cache};
});
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='dev_user'&&state.cookie?{name,value:state.cookie}:undefined}),headers:async()=>new Headers()}));
vi.mock('../db/client',()=>{
 const client=Object.assign(async(strings:TemplateStringsArray,...values:unknown[])=>{
  const text=strings.join('?');
  if(text.includes('app.principal(')){db.calls.push('principal:'+String(values[0]));
   if(db.failPrincipal>0){db.failPrincipal--;throw new Error('Fictional connection failure');}
   const row=db.principals.get(String(values[0]));return row?[row]:[];}
  if(text.includes('app.login_blocked(')){db.calls.push('blocked:'+String(values[0]));return [{blocked:db.blocked.has(String(values[0]))}];}
  throw new Error('Unexpected statement: '+text);
 },{begin:async(fn:(tx:{unsafe:(q:string,params?:unknown[])=>Promise<unknown[]>})=>unknown)=>{
  db.calls.push('snapshot');
  if(db.failSnapshot>0){db.failSnapshot--;throw new Error('Fictional snapshot failure');}
  return fn({unsafe:async(q:string)=>/set_config/.test(q)?[]:[{modules:[{code:'payroll',company:null}],settings:{},tenant_status:'active'}]});
 }});
 return {client};
});

import {getBrowserCommandSession,getSession} from '../lib/session';
import {AuthRequiredError} from '../lib/auth-errors';

const TENANT='00000000-0000-4000-8000-0000000000aa',ALICE='00000000-0000-4000-8000-0000000000a1',UNKNOWN='00000000-0000-4000-8000-0000000000ff';
const count=(prefix:string)=>db.calls.filter(call=>call===prefix).length;
/** One request: a fresh scope for its duration. */
async function inRequest<T>(run:()=>Promise<T>):Promise<T>{state.scope=new Map();try{return await run();}finally{state.scope=null;}}

beforeEach(()=>{
 db.calls=[];db.principals=new Map([[ALICE,{tenant_id:TENANT,person_id:'00000000-0000-4000-8000-0000000000b1',grants:[{role:'hr_admin',companyId:null}]}]]);
 db.blocked=new Set();db.failPrincipal=0;db.failSnapshot=0;state.cookie=ALICE;state.scope=null;
 vi.stubEnv('DEV_USER_ID',ALICE);vi.stubEnv('AUTH_PROVIDER','');vi.stubEnv('ALLOW_DEMO_SESSION','');
 vi.spyOn(console,'error').mockImplementation(()=>undefined);
});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});

describe('one request, two session carriers',()=>{
 it('shares the principal and login-block reads, and each carrier still gets its own session',async()=>{
  const [page,command]=await inRequest(()=>Promise.all([getSession(),getBrowserCommandSession()]));
  expect(page).toMatchObject({tenantId:TENANT,userId:ALICE,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]});
  expect(command).toEqual(page);
  expect(command).not.toBe(page);
  expect(command.grants).not.toBe(page.grants);
  expect(count('principal:'+ALICE)).toBe(1);
  expect(count('blocked:'+ALICE)).toBe(1);
 });

 it('outside a request reads afresh on every call, as before',async()=>{
  await getSession();await getBrowserCommandSession();
  expect(count('principal:'+ALICE)).toBe(2);
  expect(count('blocked:'+ALICE)).toBe(2);
 });

 it('keeps each carrier\'s rules: an unknown selection self-heals for getSession and is refused for a command',async()=>{
  state.cookie=UNKNOWN;
  await inRequest(async()=>{
   expect((await getSession()).userId).toBe(ALICE);
   await expect(getBrowserCommandSession()).rejects.toBeInstanceOf(AuthRequiredError);
  });
  expect(count('principal:'+UNKNOWN)).toBe(1);
  expect(count('principal:'+ALICE)).toBe(1);
  expect(count('blocked:'+ALICE)).toBe(1);
 });

 it('refuses a blocked identity on both carriers, never falling back',async()=>{
  db.blocked.add(ALICE);
  await inRequest(async()=>{
   await expect(getSession()).rejects.toBeInstanceOf(AuthRequiredError);
   await expect(getBrowserCommandSession()).rejects.toBeInstanceOf(AuthRequiredError);
  });
  expect(count('principal:'+ALICE)).toBe(1);
  expect(count('blocked:'+ALICE)).toBe(1);
  expect(count('snapshot')).toBe(0);
 });

 it('does not keep a failed read: the next carrier reads again',async()=>{
  db.failPrincipal=1;
  await inRequest(async()=>{
   await expect(getSession()).rejects.toThrow('Fictional connection failure');
   expect((await getBrowserCommandSession()).userId).toBe(ALICE);
  });
  expect(count('principal:'+ALICE)).toBe(2);
 });
});
