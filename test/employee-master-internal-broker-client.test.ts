import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
const fake=vi.hoisted(()=>{
 class Stream{listeners=new Map<string,((...args:unknown[])=>void)[]>();data='';on(name:string,fn:(...args:unknown[])=>void){this.listeners.set(name,[...(this.listeners.get(name)??[]),fn]);return this;}emit(name:string,...args:unknown[]){for(const fn of this.listeners.get(name)??[])fn(...args);}end(body:string){this.data=body;}}
 const children:{stdout:Stream;stderr:Stream;stdin:Stream;on:Stream['on'];emit:Stream['emit'];pid:number}[]=[];
 const calls:{program:string;args:readonly string[];options:unknown}[]=[];
 const spawn=(program:string,args:readonly string[],options:unknown)=>{const events=new Stream(),child={stdout:new Stream(),stderr:new Stream(),stdin:new Stream(),on:events.on.bind(events),emit:events.emit.bind(events),pid:43210};children.push(child);calls.push({program,args,options});return child;};
 return {children,calls,spawn};
});
vi.mock('node:child_process',async original=>({...await original<typeof import('node:child_process')>(),spawn:fake.spawn}));
import {employeeMasterBrokerRequest,parseReportBrokerReply,REPORT_BROKER_RESPONSE_MAX_BYTES} from '../lib/employee-master-delivery-broker';
beforeEach(()=>{fake.children.length=0;fake.calls.length=0;vi.spyOn(process,'kill').mockReturnValue(true);});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
describe('keyless broker activation-retirement client',()=>{
 it('requires the immutable keyless client to exit zero rather than accepting complete JSON and stdout EOF',async()=>{
  let resolved=false;const promise=employeeMasterBrokerRequest({phase:'status'}).then(value=>{resolved=true;return value;}),child=fake.children[0];
  expect(fake.calls[0]).toMatchObject({program:'/usr/bin/python3',args:['-I','/usr/local/lib/aihr-identity-email/report-auth-peer.py','--client'],options:{detached:true,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC'}}});
  expect(child.stdin.data).toBe('{"phase":"status"}');child.stdout.emit('data',Buffer.from('{"available":true}'));child.stdout.emit('end');await Promise.resolve();expect(resolved).toBe(false);
  child.emit('close',0);expect(await promise).toEqual({available:true});
 });
 it('never copies private sender, Auth, DB or CA environment into the helper',()=>{const promise=employeeMasterBrokerRequest({phase:'status'});expect(Object.keys((fake.calls[0].options as {env:object}).env).sort()).toEqual(['LANG','LC_ALL','PATH','TZ']);fake.children[0].stdout.emit('data',Buffer.from('{"available":true}'));fake.children[0].emit('close',0);return promise;});
 it.each([1,78,null])('refuses helper exit %j despite a complete reply',async code=>{const promise=employeeMasterBrokerRequest({phase:'status'}),child=fake.children[0];child.stdout.emit('data',Buffer.from('{"available":true}'));child.emit('close',code);await expect(promise).rejects.toThrow('unavailable');});
 it.each(['partial','oversize','error'])('refuses %s without returning material',async kind=>{const promise=employeeMasterBrokerRequest({phase:'status'}),child=fake.children[0];if(kind==='error')child.emit('error',new Error('private details'));else{child.stdout.emit('data',Buffer.from(kind==='partial'?'{"available":':'x'.repeat(REPORT_BROKER_RESPONSE_MAX_BYTES+1)));child.emit('close',0);}await expect(promise).rejects.toThrow('unavailable');});
 it('bounds a helper that never proves retirement',async()=>{vi.useFakeTimers();const promise=employeeMasterBrokerRequest({phase:'status'}),refusal=expect(promise).rejects.toThrow('unavailable');await vi.advanceTimersByTimeAsync(45_000);await refusal;expect(process.kill).toHaveBeenCalledWith(-43210,'SIGKILL');});
 it('refuses wrong phase, material on status and unknown properties',()=>{expect(()=>parseReportBrokerReply('{"available":true}','start')).toThrow();expect(()=>parseReportBrokerReply('{"available":true,"password":"no"}','status')).toThrow();expect(()=>parseReportBrokerReply('{"ok":false,"reason":"unavailable","key":"no"}','inspect')).toThrow();});
 it('refuses caller identity/path/relay before launching any child',()=>{expect(()=>employeeMasterBrokerRequest({phase:'status',path:'/etc/private'} as never)).toThrow();expect(fake.children).toHaveLength(0);});
});
