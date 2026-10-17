/** Pure command-behavior contract; no systemd, subprocess, filesystem or scheduler mutation. */
import {describe,it,expect,vi} from 'vitest';
import {dispatchSha256} from '../lib/employee-master-dispatch';
import {reportTimerInventory} from '../deploy/identity-email/report-timer-inventory';
function fixture(files=['plain.timer','backup@.timer'],initial=['backup@customer.timer']){
 const loaded=new Set(initial),bodies=new Map<string,string>([['plain.timer','plain timer'],['plain.service','plain service'],['backup@.timer','backup template'],['backup@aihr-report-inventory.timer','probe effective template'],['backup@aihr-report-inventory.service','probe service'],['backup@customer.timer','customer timer override'],['backup@customer.service','customer service override']]);
 const triggers=new Map([['plain.timer','plain.service'],['backup@aihr-report-inventory.timer','backup@aihr-report-inventory.service'],['backup@customer.timer','backup@customer.service']]);
 const inspect=vi.fn((_body:string,_scope:string)=>{});
 const command=vi.fn((program:string,args:string[])=>{
  if(program!=='systemctl')throw new Error('Unexpected executable');
  if(args[0]==='list-unit-files')return files.map(unit=>unit+' disabled enabled').join('\n');
  if(args[0]==='list-units')return [...loaded].sort().map(unit=>unit+' loaded inactive dead').join('\n');
  if(args[0]==='cat'){const body=bodies.get(args[1]);if(body===undefined)throw new Error('Unknown effective configuration');return body;}
  if(args[0]==='show'){
   if(args[1].endsWith('@.timer'))throw new Error('Bare template is not a valid unit name (exit1)');
   loaded.add(args[1]);const target=triggers.get(args[1]);if(target===undefined)throw new Error('Unknown trigger');return target;
  }
  throw new Error('Mutation or unknown command refused');
 });
 return {command,inspect,loaded,bodies,triggers};
}
describe('effective systemd timer inventory',()=>{
 it('retains ordinary timer and service configuration hashes',()=>{
  const f=fixture(['plain.timer'],[]);expect(reportTimerInventory(f.command,f.inspect)).toEqual([['timer:plain.timer',dispatchSha256('plain timer')],['timer-service:plain.service',dispatchSha256('plain service')]]);
 });
 it('hashes template, planned probe and real loaded overrides without showing bare templates',()=>{
  const f=fixture(),entries=reportTimerInventory(f.command,f.inspect);
  for(const [key,body] of [['timer:backup@.timer','backup template'],['timer:backup@aihr-report-inventory.timer','probe effective template'],['timer:backup@customer.timer','customer timer override'],['timer-service:backup@customer.service','customer service override']])expect(entries).toContainEqual([key,dispatchSha256(body)]);
  expect(f.command.mock.calls.some(([,args])=>args[0]==='show'&&args[1].endsWith('@.timer'))).toBe(false);
  expect(f.command.mock.calls.findIndex(([,args])=>args[0]==='list-units')).toBeLessThan(f.command.mock.calls.findIndex(([,args])=>args[0]==='cat'||args[0]==='show'));
 });
 it('keeps the first and repeated digest identical when show loads planned probe instances',()=>{
  const f=fixture(),first=reportTimerInventory(f.command,f.inspect),second=reportTimerInventory(f.command,f.inspect);expect(f.loaded.has('backup@aihr-report-inventory.timer')).toBe(true);expect(second).toEqual(first);
 });
 it('passes instance-specific competing service contents through the refusing inspector',()=>{
  const f=fixture();f.bodies.set('backup@customer.service','competing instance command');f.inspect.mockImplementation((body,scope)=>{if(body==='competing instance command'&&scope==='backup@customer.service')throw new Error('Competing installed report schedule');});
  expect(()=>reportTimerInventory(f.command,f.inspect)).toThrow('Competing installed report schedule');
 });
 it.each(['foreign.socket','bad/name.service','backup@.service','bad@@name.service'])('refuses unknown or non-invocable trigger %s',target=>{
  const f=fixture(['plain.timer'],[]);f.triggers.set('plain.timer',target);expect(()=>reportTimerInventory(f.command,f.inspect)).toThrow();
 });
 it.each(['bad/name.timer','bad@@name.timer','name.service'])('refuses malformed timer names before effective queries: %s',unit=>{
  const f=fixture([unit],[]);expect(()=>reportTimerInventory(f.command,f.inspect)).toThrow();expect(f.command.mock.calls.some(([,args])=>args[0]==='cat'||args[0]==='show')).toBe(false);
 });
 it('refuses an uninspectable loaded timer rather than omitting it',()=>{
  const f=fixture(['plain.timer'],['unknown@customer.timer']);expect(()=>reportTimerInventory(f.command,f.inspect)).toThrow('Unknown effective configuration');
 });
});
