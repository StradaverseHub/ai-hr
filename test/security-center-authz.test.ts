import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({session:vi.fn(),admin:vi.fn(),isAdmin:vi.fn(),group:vi.fn(),configure:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:m.session}));
vi.mock('../lib/authz',()=>({requireAdmin:m.admin,isAdmin:m.isAdmin,isGroupAdmin:m.group}));
vi.mock('../core/access-configuration-editor',()=>({canConfigureAccess:m.configure}));
vi.mock('next/navigation',()=>({redirect:(href:string)=>{throw new Error('REDIRECT '+href);}}));
import {requireSecurityCenter,requireGroupAdministration} from '../lib/security-center-authz';
const principal={tenantId:'tenant',userId:'current-server-user'};
beforeEach(()=>{vi.resetAllMocks();m.session.mockResolvedValue(principal);m.admin.mockResolvedValue(principal);m.isAdmin.mockReturnValue(false);m.group.mockReturnValue(false);m.configure.mockResolvedValue(false);});
describe('Security Center keeps page authority with its current owner',()=>{
 it('admits a configure-only user without requiring role administration',async()=>{
  m.configure.mockResolvedValue(true);expect(await requireSecurityCenter()).toEqual({session:principal,access:{admin:false,configure:true,provision:false}});expect(m.admin).not.toHaveBeenCalled();expect(m.configure).toHaveBeenCalledWith(principal);
 });
 it('admits HR admins and withholds provisioning from company-scoped admins',async()=>{
  m.isAdmin.mockReturnValue(true);expect((await requireSecurityCenter()).access).toEqual({admin:true,configure:false,provision:false});await expect(requireGroupAdministration()).rejects.toThrow('REDIRECT /admin/security-center');
  m.group.mockReturnValue(true);expect(await requireGroupAdministration()).toBe(principal);
 });
 it('refuses denied or stale authority and propagates authentication failures',async()=>{
  await expect(requireSecurityCenter()).rejects.toThrow('REDIRECT /');m.configure.mockResolvedValueOnce(true);await requireSecurityCenter();await expect(requireSecurityCenter()).rejects.toThrow('REDIRECT /');
  m.session.mockRejectedValue(new Error('authentication'));await expect(requireSecurityCenter()).rejects.toThrow('authentication');
  m.admin.mockRejectedValue(new Error('denied'));await expect(requireGroupAdministration()).rejects.toThrow('denied');
 });
});
