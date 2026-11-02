import {afterEach,describe,it,expect,vi} from 'vitest';
const lookup=vi.hoisted(()=>vi.fn());
vi.mock('../lib/entra/store',()=>({connectorByOrganization:lookup}));
import {microsoftLoginEnabled} from '../lib/entra/login-options-server';
afterEach(()=>vi.resetAllMocks());
describe('public organization Microsoft login availability',()=>{
 it('uses the current sign-in switch independently of provisioning',async()=>{
  lookup.mockResolvedValueOnce({enabled:true,provisioningEnabled:false,clientSecret:'private'});
  expect(await microsoftLoginEnabled('acme')).toBe(true);
  lookup.mockResolvedValueOnce({enabled:false,provisioningEnabled:true});expect(await microsoftLoginEnabled('acme')).toBe(false);
 });
 it('returns false for unknown/unconfigured organizations and lookup failures',async()=>{
  lookup.mockRejectedValueOnce(Error('unconfigured'));expect(await microsoftLoginEnabled('unknown')).toBe(false);
 });
 it.each(['','a','../../admin','x'.repeat(65)])('refuses malformed organization %s before lookup',async organization=>{
  expect(await microsoftLoginEnabled(organization)).toBe(false);expect(lookup).not.toHaveBeenCalled();
 });
});
