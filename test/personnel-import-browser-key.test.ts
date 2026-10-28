/** Privacy-context state lifetime only; this key grants no permission and proves no real login. */
import {expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {personnelImportBrowserKey} from '../lib/personnel-import-browser-key';
import type {SessionContext} from '../db/client';
const ctx:SessionContext={tenantId:'fixture-tenant',userId:'fixture-user',personId:'fixture-person',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:'company-a'},{role:'hr_admin',companyId:'company-b'}]};
it('changes the client state key when actual tenant, login, person, grants or visible company scope changes',()=>{
 const key=personnelImportBrowserKey(ctx,['company-a','company-b']);
 for(const changed of [{...ctx,tenantId:'other-tenant'},{...ctx,userId:'other-user'},{...ctx,personId:'other-person'},{...ctx,grants:[ctx.grants![0]]}])expect(personnelImportBrowserKey(changed,['company-a','company-b'])).not.toBe(key);
 expect(personnelImportBrowserKey(ctx,['company-a'])).not.toBe(key);expect(key).toMatch(/^[a-f0-9]{64}$/);expect(key).not.toContain('fixture');
});
it('preserves state across incidental ordering changes for the same current privacy context',()=>{
 expect(personnelImportBrowserKey(ctx,['company-a','company-b'])).toBe(personnelImportBrowserKey({...ctx,grants:[...ctx.grants!].reverse()},['company-b','company-a','company-a']));
});
