import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({session:vi.fn(),headers:vi.fn(),demo:vi.fn(),probe:vi.fn(),acquire:vi.fn(),audit:vi.fn(),release:vi.fn()}));
vi.mock('next/headers',()=>({headers:m.headers}));
vi.mock('../lib/session',()=>({getSession:m.session}));
vi.mock('../lib/demo-mode',()=>({demoSwitcherEnabled:m.demo}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:()=>false}));
vi.mock('../lib/demo-smtp-probe',()=>({probeDemoSmtp:m.probe}));
vi.mock('../lib/demo-smtp-budget',()=>({demoSmtpBudget:{acquire:m.acquire}}));
vi.mock('../db/client',()=>({withTenant:async(_s:unknown,fn:(tx:unknown)=>unknown)=>fn({})}));
vi.mock('../db/events',()=>({appendEvent:m.audit,actorOf:(s:{userId:string})=>({type:'user',id:s.userId})}));
import {testDemoSmtpConnection} from '../app/(app)/admin/settings/email/demo-actions';
const session={tenantId:'11111111-1111-1111-1111-111111111111',userId:'22222222-2222-2222-2222-222222222222',roles:['hr_admin']};
function form(){const f=new FormData();for(const [k,v]of Object.entries({host:'smtp.example.com',port:'465',security:'tls',auth:'true',user:'synthetic-user',password:'synthetic-secret',from:'ignored@example.test',actor:'forged'}))f.set(k,v);return f;}
beforeEach(()=>{vi.clearAllMocks();m.demo.mockReturnValue(true);m.headers.mockResolvedValue(new Headers({'x-pathname':'/admin/settings/email'}));m.session.mockResolvedValue(session);m.probe.mockResolvedValue({status:'success',authenticated:true});m.acquire.mockReturnValue(m.release);m.audit.mockResolvedValue(undefined);});
describe('demo connection action boundary',()=>{
 it.each(['employee','manager','payroll_partner','performance_comp_partner'])('refuses %s before any audit or network activity',async role=>{
  m.session.mockResolvedValue({...session,roles:[role]});expect(await testDemoSmtpConnection(form())).toEqual({status:'error',code:'forbidden'});expect(m.probe).not.toHaveBeenCalled();expect(m.audit).not.toHaveBeenCalled();
 });
 it.each(['/login','/callback','/invite','/reset-password','/api/mobile/v1/me',null])('refuses an action invoked outside its protected settings route: %s',async path=>{
  m.headers.mockResolvedValue(new Headers(path?{'x-pathname':path}:{}));expect(await testDemoSmtpConnection(form())).toEqual({status:'error',code:'forbidden'});expect(m.session).not.toHaveBeenCalled();expect(m.probe).not.toHaveBeenCalled();expect(m.audit).not.toHaveBeenCalled();
 });
 it('refuses real deployments even for an HR administrator',async()=>{
  m.demo.mockReturnValue(false);expect(await testDemoSmtpConnection(form())).toEqual({status:'error',code:'forbidden'});expect(m.session).not.toHaveBeenCalled();expect(m.probe).not.toHaveBeenCalled();
 });
 it('audits only server-derived references and result categories, with no SMTP details',async()=>{
  expect(await testDemoSmtpConnection(form())).toEqual({status:'success',authenticated:true});
  expect(m.probe).toHaveBeenCalledWith({host:'smtp.example.com',port:465,security:'tls',auth:true,user:'synthetic-user',password:'synthetic-secret'});
  expect(m.audit).toHaveBeenCalledTimes(2);const requested=m.audit.mock.calls[0][1],finished=m.audit.mock.calls[1][1];
  expect(requested.actor).toEqual({type:'user',id:session.userId});expect(requested.payload).toEqual({demo:true});expect(finished.aggregateId).toBe(requested.aggregateId);expect(finished.payload).toEqual({demo:true,outcome:'success',authenticated:true});
  for(const secret of ['smtp.example.com','synthetic-user','synthetic-secret','ignored@example.test','forged'])expect(JSON.stringify(m.audit.mock.calls)).not.toContain(secret);
  expect(m.release).toHaveBeenCalledExactlyOnceWith();
 });
 it('requires durable intent before any connection attempt and releases the slot on failure',async()=>{
  m.audit.mockRejectedValue(Error('audit unavailable'));expect(await testDemoSmtpConnection(form())).toEqual({status:'error',code:'unavailable'});expect(m.probe).not.toHaveBeenCalled();expect(m.release).toHaveBeenCalledOnce();
 });
 it('does not expose an unaudited success or credential-bearing exception',async()=>{
  m.audit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('synthetic-secret'));
  expect(await testDemoSmtpConnection(form())).toEqual({status:'error',code:'unavailable'});expect(m.release).toHaveBeenCalledOnce();
 });
 it('rejects malformed authentication, ports and missing secrets before admission',async()=>{
  for(const [k,v]of [['auth','forged'],['port','0'],['password','']]){const f=form();f.set(k,v);expect(await testDemoSmtpConnection(f)).toEqual({status:'error',code:'invalid'});}
  expect(m.acquire).not.toHaveBeenCalled();expect(m.probe).not.toHaveBeenCalled();
 });
 it('refuses overload without opening a socket',async()=>{m.acquire.mockReturnValue(null);expect(await testDemoSmtpConnection(form())).toEqual({status:'error',code:'busy'});expect(m.probe).not.toHaveBeenCalled();});
});
