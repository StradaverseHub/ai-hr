import {EventEmitter} from 'node:events';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type SMTPConnection from 'nodemailer/lib/smtp-connection';
import type {SMTPConnectionOptions} from 'nodemailer/lib/smtp-connection';
import {isPublicIp} from '../lib/public-network';
import {probeDemoSmtp,smtpProbeFailure} from '../lib/demo-smtp-probe';
import {demoSmtpSchema,type DemoSmtpConfig} from '../lib/demo-smtp-model';
import {createDemoSmtpBudget} from '../lib/demo-smtp-budget';
const config:DemoSmtpConfig={host:'smtp.example.com',port:465,security:'tls',auth:true,user:'synthetic-user',password:'synthetic-secret'};
class Connection extends EventEmitter {
 secure=true;allowsAuth=true;authenticated=false;
 close=vi.fn();
 connect=vi.fn((cb:(e?:Error)=>void)=>cb());
 login=vi.fn((_auth:unknown,cb:(e?:Error)=>void)=>{this.authenticated=true;cb();});
}
function fixture(addresses=['8.8.8.8']){
 const client=new Connection();let options:SMTPConnectionOptions|undefined;
 const resolve=vi.fn(async()=>addresses),connection=vi.fn((o:SMTPConnectionOptions)=>{options=o;return client as unknown as SMTPConnection;});
 return {client,deps:{resolve,connection},options:()=>options};
}
afterEach(()=>vi.useRealTimers());
describe('public SMTP egress policy',()=>{
 it.each(['127.0.0.1','0.0.0.0','10.1.2.3','172.16.0.1','192.168.1.2','169.254.169.254','100.64.0.1','192.0.2.1','198.51.100.1','203.0.113.1','198.18.0.1','224.1.2.3','255.255.255.255','::','::1','::ffff:8.8.8.8','::ffff:7f00:1','::127.0.0.1','fe90::1','febf::1','fc00::1','fec0::1','ff02::1','64:ff9b::7f00:1','2002:7f00:1::','2001::1','2001:db8::1','3fff::1','2606:4700::1%eth0','not-an-ip'])('refuses %s',ip=>expect(isPublicIp(ip)).toBe(false));
 it.each(['8.8.8.8','1.1.1.1','203.0.200.5','2606:4700:4700::1111','2001:4860:4860::8888','2a00:1450::1'])('permits native public %s',ip=>expect(isPublicIp(ip)).toBe(true));
});
describe('connection and AUTH only',()=>{
 it('pins the public IP while checking the original hostname certificate, and closes after AUTH',async()=>{
  const f=fixture();expect(await probeDemoSmtp(config,f.deps)).toEqual({status:'success',authenticated:true});
  expect(f.options()).toMatchObject({host:'8.8.8.8',port:465,servername:config.host,secure:true,requireTLS:false,tls:{servername:config.host,rejectUnauthorized:true,minVersion:'TLSv1.2'},logger:false,debug:false,transactionLog:false,maxResponseSize:8192});
  expect(f.options()).not.toHaveProperty('auth');expect(f.client.login).toHaveBeenCalledWith({user:config.user,pass:config.password},expect.any(Function));expect(f.client.close).toHaveBeenCalled();
 });
 it('requires STARTTLS on 587 and refuses credentials until the connection is secure',async()=>{
  const f=fixture();f.client.secure=false;
  expect(await probeDemoSmtp({...config,port:587,security:'starttls'},f.deps)).toEqual({status:'error',code:'tlsFailed'});
  expect(f.options()).toMatchObject({secure:false,requireTLS:true,opportunisticTLS:false});expect(f.client.login).not.toHaveBeenCalled();
 });
 it.each([['127.0.0.1'],['8.8.8.8','10.0.0.1'],['2606:4700::1','fe90::1']])('refuses private and mixed DNS answers before opening a socket: %j',async(...ips)=>{
  const f=fixture(ips);expect(await probeDemoSmtp(config,f.deps)).toEqual({status:'error',code:'blockedHost'});expect(f.deps.connection).not.toHaveBeenCalled();
 });
 it('reports a connection without claiming authentication when it was not requested',async()=>{
  const f=fixture();expect(await probeDemoSmtp({...config,auth:false,user:'',password:''},f.deps)).toEqual({status:'success',authenticated:false});expect(f.client.login).not.toHaveBeenCalled();
 });
 it('refuses missing AUTH and an unconfirmed login instead of reporting success',async()=>{
  const f=fixture();f.client.allowsAuth=false;expect(await probeDemoSmtp(config,f.deps)).toEqual({status:'error',code:'authenticationFailed'});
  const g=fixture();g.client.login.mockImplementation((_a,cb)=>cb());expect(await probeDemoSmtp(config,g.deps)).toEqual({status:'error',code:'authenticationFailed'});
 });
 it('sanitizes provider errors and TLS causes without reflecting credentials',async()=>{
  const f=fixture();f.client.login.mockImplementation((_a,cb)=>cb(Object.assign(new Error('535 echoed synthetic-secret'),{code:'EAUTH'})));
  const result=await probeDemoSmtp(config,f.deps);expect(result).toEqual({status:'error',code:'authenticationFailed'});expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  expect(smtpProbeFailure({code:'ESOCKET',originalCode:'CERT_HAS_EXPIRED'})).toBe('tlsFailed');
 });
 it('bounds a stalled SMTP exchange and closes its socket',async()=>{
  vi.useFakeTimers();const f=fixture();f.client.connect.mockImplementation(()=>{});
  const result=probeDemoSmtp(config,f.deps);await vi.advanceTimersByTimeAsync(15001);
  expect(await result).toEqual({status:'error',code:'connectionFailed'});expect(f.client.close).toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 });
 it('clears the deadline when the library throws synchronously',async()=>{
  vi.useFakeTimers();const f=fixture();f.client.connect.mockImplementation(()=>{throw Error('synthetic-secret');});
  expect(await probeDemoSmtp(config,f.deps)).toEqual({status:'error',code:'connectionFailed'});expect(vi.getTimerCount()).toBe(0);
 });
 it.each([{port:0},{port:65536},{security:'none'},{password:''},{user:''}])('rejects unsupported or incomplete input before DNS: %j',async patch=>{
  const f=fixture();expect(await probeDemoSmtp({...config,...patch} as DemoSmtpConfig,f.deps)).toEqual({status:'error',code:'invalid'});expect(f.deps.resolve).not.toHaveBeenCalled();
 });
 it('accepts a custom SMTP port with required STARTTLS',()=>{expect(demoSmtpSchema.parse({...config,port:2525,security:'starttls'}).port).toBe(2525);});
 it('normalizes the host while retaining the exact password',()=>{
  expect(demoSmtpSchema.parse({...config,host:' SMTP.EXAMPLE.COM ',password:'  spaces matter  '})).toMatchObject({host:'smtp.example.com',password:'  spaces matter  '});
 });
});
describe('probe admission',()=>{
 it('caps concurrent requests and releases once',()=>{
  const budget=createDemoSmtpBudget();const a=budget.acquire('a')!,b=budget.acquire('b')!;expect(budget.acquire('c')).toBeNull();a();a();const c=budget.acquire('c')!;expect(c).toBeTypeOf('function');expect(budget.acquire('d')).toBeNull();b();c();
 });
 it('permits only one in-flight attempt per actor',()=>{const budget=createDemoSmtpBudget();const done=budget.acquire('a')!;expect(budget.acquire('a')).toBeNull();done();expect(budget.acquire('a')).toBeTypeOf('function');});
 it('caps per-user and global attempts and expires the window',()=>{
  let time=0;const budget=createDemoSmtpBudget(()=>time);
  for(let i=0;i<6;i++)budget.acquire('a')!();expect(budget.acquire('a')).toBeNull();
  for(let i=0;i<6;i++)budget.acquire('b')!();expect(budget.acquire('c')).toBeNull();
  time=60001;expect(budget.acquire('a')).toBeTypeOf('function');
 });
});
