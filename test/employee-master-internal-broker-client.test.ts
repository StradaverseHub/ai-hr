import {beforeEach,describe,it,expect,vi} from 'vitest';
const fake=vi.hoisted(()=>{
 const sockets:{emit:(name:string,...args:unknown[])=>void;path?:string;sent?:string;destroyed:boolean}[]=[];
 class Socket {
  listeners=new Map<string,((...args:unknown[])=>void)[]>();path?:string;sent?:string;destroyed=false;
  constructor(){sockets.push(this);}
  setTimeout(){return this;}
  on(name:string,fn:(...args:unknown[])=>void){this.listeners.set(name,[...(this.listeners.get(name)??[]),fn]);return this;}
  emit(name:string,...args:unknown[]){for(const fn of this.listeners.get(name)??[])fn(...args);}
  connect(path:string,fn:()=>void){this.path=path;fn();return this;}
  end(body:string){this.sent=body;return this;}
  destroy(){this.destroyed=true;return this;}
 }
 return {Socket,sockets};
});
vi.mock('node:net',async importOriginal=>({...await importOriginal<typeof import('node:net')>(),Socket:fake.Socket}));
import {employeeMasterBrokerRequest,parseReportBrokerReply,REPORT_BROKER_RESPONSE_MAX_BYTES} from '../lib/employee-master-delivery-broker';
beforeEach(()=>{fake.sockets.length=0;});
describe('keyless private broker client',()=>{
 it('waits for EOF rather than treating complete JSON data as committed authorization',async()=>{
  let resolved=false;const promise=employeeMasterBrokerRequest({phase:'status'}).then(value=>{resolved=true;return value;});const socket=fake.sockets[0];
  expect(socket.path).toBe('/run/aihr-report-auth.sock');expect(socket.sent).toBe('{"phase":"status"}');socket.emit('data',Buffer.from('{"available":true}'));await Promise.resolve();expect(resolved).toBe(false);
  socket.emit('end');expect(await promise).toEqual({available:true});expect(socket.destroyed).toBe(true);
 });
 it('refuses socket close without EOF, even after a syntactically complete reply',async()=>{
  const promise=employeeMasterBrokerRequest({phase:'status'});fake.sockets[0].emit('data',Buffer.from('{"available":true}'));fake.sockets[0].emit('close');await expect(promise).rejects.toThrow('unavailable');
 });
 it.each(['partial','oversize','error'])('refuses %s without returning material',async kind=>{
  const promise=employeeMasterBrokerRequest({phase:'status'}),socket=fake.sockets[0];if(kind==='error')socket.emit('error',new Error('private details'));else {socket.emit('data',Buffer.from(kind==='partial'?'{"available":':'x'.repeat(REPORT_BROKER_RESPONSE_MAX_BYTES+1)));socket.emit('end');}await expect(promise).rejects.toThrow('unavailable');
 });
 it('refuses wrong phase, material on status and unknown properties',()=>{
  expect(()=>parseReportBrokerReply('{"available":true}','start')).toThrow();expect(()=>parseReportBrokerReply('{"available":true,"password":"no"}','status')).toThrow();expect(()=>parseReportBrokerReply('{"ok":false,"reason":"unavailable","key":"no"}','inspect')).toThrow();
 });
 it('refuses sender-supplied identity/path/relay before opening any socket',()=>{
  expect(()=>employeeMasterBrokerRequest({phase:'status',path:'/etc/private'} as never)).toThrow();expect(fake.sockets).toHaveLength(0);
 });
});
