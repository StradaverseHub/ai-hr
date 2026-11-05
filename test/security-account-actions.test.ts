/** Real server action; synthetic identity, canonical account owner and revalidation ports. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const ports=vi.hoisted(()=>({session:vi.fn(),manage:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:ports.session}));
vi.mock('../core/account-management',()=>({manageAccount:ports.manage}));
vi.mock('next/cache',()=>({revalidatePath:ports.revalidate}));
import {accountAction} from '../app/admin/users/[userId]/account/actions';
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
});
