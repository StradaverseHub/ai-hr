/** Real server action; synthetic identity, canonical account owner and revalidation ports. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const ports=vi.hoisted(()=>({session:vi.fn(),manage:vi.fn(),generate:vi.fn(),history:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:ports.session}));
vi.mock('../core/account-management',()=>({manageAccount:ports.manage,generateManagedAccountPassword:ports.generate,readManagedAccountHistory:ports.history}));
vi.mock('next/cache',()=>({revalidatePath:ports.revalidate}));
import {accountAction,accountHistoryAction,generatePasswordAction} from '../app/admin/users/[userId]/account/actions';
import {instantFromKualaLumpurLocal,kualaLumpurLocalInput} from '../lib/hr-date';
import {currentEmployeeCode} from '../lib/current-employee-code';
const actor={tenantId:'fictional-tenant',userId:'verified-actor',roles:['hr_admin']};
const initial={status:'idle' as const};
function form(type='suspend'){
 const value=new FormData();Object.entries({userId:'fictional-target',type,reason:'Fictional reviewed recovery',confirmed:'on',actorId:'forged-actor',tenantId:'forged-tenant',returnTo:'https://foreign.invalid'}).forEach(([key,text])=>value.set(key,text));return value;
}
beforeEach(()=>{vi.clearAllMocks();ports.session.mockResolvedValue(actor);ports.manage.mockResolvedValue({});});
describe('Security Center sensitive account actions',()=>{
 it('uses the verified server session and exact target, then refreshes only fixed owning routes',async()=>{
  expect(await accountAction(initial,form())).toEqual({status:'saved'});
  expect(ports.manage).toHaveBeenCalledExactlyOnceWith(actor,'fictional-target',{type:'suspend',reason:'Fictional reviewed recovery'});
  expect(ports.revalidate.mock.calls).toEqual([['/admin/users'],['/admin/users/fictional-target/account']]);
 });
 it.each(['confirmed','reason'])('refuses missing %s through confirmation or canonical owner validation',async field=>{
  const value=form();value.delete(field);
  if(field==='reason')ports.manage.mockRejectedValue(Error('invalid'));
  expect(await accountAction(initial,value)).toEqual({status:'failed'});expect(ports.revalidate).not.toHaveBeenCalled();
  if(field==='confirmed')expect(ports.manage).not.toHaveBeenCalled();
 });
 it('requires matching confirmation for a manually entered password before invoking the owner',async()=>{
  const value=form('temporary-password');value.set('password','Fictional password 934!');value.set('confirmPassword','different');value.set('minutes','30');
  expect(await accountAction(initial,value)).toEqual({status:'failed'});expect(ports.manage).not.toHaveBeenCalled();
  value.set('confirmPassword','Fictional password 934!');ports.manage.mockResolvedValue({password:'Fictional password 934!'});
  expect(await accountAction(initial,value)).toEqual({status:'saved',password:'Fictional password 934!'});
  expect(ports.manage).toHaveBeenCalledWith(actor,'fictional-target',{type:'temporary-password',reason:'Fictional reviewed recovery',password:'Fictional password 934!',minutes:30});
 });
 it('allows generation without client password bytes and reports actual mail outcome',async()=>{
  const value=form('temporary-password');value.set('minutes','30');ports.manage.mockResolvedValue({password:'Fictional generated 935!'});
  expect(await accountAction(initial,value)).toEqual({status:'saved',password:'Fictional generated 935!'});
  ports.manage.mockResolvedValue({delivery:'failed'});expect(await accountAction(initial,form('reset-email'))).toEqual({status:'saved',delivery:'failed'});
 });
 it('redacts owner failures, refuses unknown commands and never revalidates on denied authority',async()=>{
  ports.manage.mockRejectedValue(Error('PRIVATE credential or database detail'));
  expect(await accountAction(initial,form())).toEqual({status:'failed'});expect(ports.revalidate).not.toHaveBeenCalled();
  ports.manage.mockClear();expect(await accountAction(initial,form('unknown'))).toEqual({status:'failed'});expect(ports.manage).not.toHaveBeenCalled();
  ports.session.mockRejectedValue(Error('private auth failure'));expect(await accountAction(initial,form())).toEqual({status:'failed'});expect(ports.manage).not.toHaveBeenCalled();
 });

 it('issues a temporary password from the dialog with hours, an optional reason and a matching confirmation',async()=>{
  const value=form('temporary-password');value.delete('reason');value.set('password','Fictional dialog password 512!');value.set('confirmPassword','Fictional dialog password 512!');value.set('hours','24');
  ports.manage.mockResolvedValue({password:'Fictional dialog password 512!'});
  expect(await accountAction(initial,value)).toEqual({status:'saved',password:'Fictional dialog password 512!'});
  expect(ports.manage).toHaveBeenCalledExactlyOnceWith(actor,'fictional-target',{type:'temporary-password',password:'Fictional dialog password 512!',minutes:1440});
  ports.manage.mockClear();value.set('hours','25');
  expect(await accountAction(initial,value)).toEqual({status:'failed'});expect(ports.manage).not.toHaveBeenCalled();
  value.set('hours','4');value.set('confirmPassword','Fictional different password 513!');
  expect(await accountAction(initial,value)).toEqual({status:'failed'});expect(ports.manage).not.toHaveBeenCalled();
 });
 it('pauses the authenticator until an absolute Malaysia time and switches it back on',async()=>{
  const value=form('recovery-exemption');value.set('until','2026-11-12T17:00');
  expect(await accountAction(initial,value)).toEqual({status:'saved'});
  expect(ports.manage).toHaveBeenCalledExactlyOnceWith(actor,'fictional-target',{type:'recovery-exemption',reason:'Fictional reviewed recovery',expiresAt:Date.UTC(2026,10,12,9,0)});
  ports.manage.mockClear();
  for(const until of ['','2026-02-30T10:00','2026-11-12 17:00','tomorrow']){value.set('until',until);expect(await accountAction(initial,value)).toEqual({status:'failed'});}
  expect(ports.manage).not.toHaveBeenCalled();
  const cancel=form('recovery-exemption-cancel');cancel.delete('reason');
  expect(await accountAction(initial,cancel)).toEqual({status:'saved'});
  expect(ports.manage).toHaveBeenCalledExactlyOnceWith(actor,'fictional-target',{type:'recovery-exemption-cancel'});
 });
 it('generates through the verified session and exact target, redacting every failure',async()=>{
  ports.generate.mockResolvedValue('Fictional generated policy 514!');
  expect(await generatePasswordAction('fictional-target')).toEqual({status:'ok',password:'Fictional generated policy 514!'});
  expect(ports.generate).toHaveBeenCalledExactlyOnceWith(actor,'fictional-target');
  ports.generate.mockRejectedValue(Error('PRIVATE scope detail'));
  expect(await generatePasswordAction('fictional-target')).toEqual({status:'failed'});
  expect(ports.revalidate).not.toHaveBeenCalled();
 });
 it('returns only times, event names and actor names for the dialog history',async()=>{
  ports.history.mockResolvedValue([{event_type:'app-user.account-recovery-exemption',occurred_at:new Date('2026-11-10T07:12:00Z'),actor_id:'admin-id',actor_name:'Fictional Admin',reason:'Fictional private reason',expires_at:String(Date.UTC(2026,10,12,9,0))},
   {event_type:'app-user.logged-in',occurred_at:'2026-11-07T10:02:00Z',actor_id:'user-id',actor_name:'Fictional Employee',reason:null,expires_at:null}]);
  expect(await accountHistoryAction('fictional-target')).toEqual({status:'ok',entries:[
   {at:'2026-11-10T07:12:00.000Z',event:'app-user.account-recovery-exemption',actor:'Fictional Admin',until:'2026-11-12T09:00:00.000Z'},
   {at:'2026-11-07T10:02:00.000Z',event:'app-user.logged-in',actor:'Fictional Employee',until:null}]});
  expect(ports.history).toHaveBeenCalledExactlyOnceWith(actor,'fictional-target',5);
  ports.history.mockRejectedValue(Error('forbidden'));expect(await accountHistoryAction('fictional-target')).toEqual({status:'failed'});
 });
 it('reads Malaysia wall-clock times and current employee codes through their owners',()=>{
  expect(instantFromKualaLumpurLocal('2026-11-12T17:00')).toBe(Date.UTC(2026,10,12,9,0));
  expect(instantFromKualaLumpurLocal('2026-11-13T00:30')).toBe(Date.UTC(2026,10,12,16,30));
  expect(kualaLumpurLocalInput(Date.UTC(2026,10,12,16,30))).toBe('2026-11-13T00:30');
  expect(instantFromKualaLumpurLocal('2026-02-29T10:00')).toBeNull();expect(instantFromKualaLumpurLocal('2026-11-12T24:00')).toBeNull();
  const employment=(employeeCode:string|null,hiredOn:string,ended:string|null=null)=>({employeeCode,hiredOn,terminatedOn:ended,lastWorkingDate:ended});
  expect(currentEmployeeCode([employment('E0001','2020-01-01','2024-12-31'),employment('E0044','2025-01-01')],'2026-11-10')).toBe('E0044');
  expect(currentEmployeeCode([employment('E0001','2020-01-01','2024-12-31'),employment('E0002','2021-01-01','2023-01-01')],'2026-11-10')).toBe('E0001');
  expect(currentEmployeeCode([employment('E0012','2024-01-01'),employment('S0012','2025-01-01')],'2026-11-10')).toBe('S0012, E0012');
  expect(currentEmployeeCode([employment(null,'2024-01-01')],'2026-11-10')).toBeNull();
 });
});
