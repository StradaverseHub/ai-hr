import {afterEach,expect,it,vi} from 'vitest';
import {assertDisposableDraftDiscardFixture,ensureDraftDiscardTestRoles} from './helpers/personnel-draft-discard-ci-role-fixture';

afterEach(()=>vi.unstubAllEnvs());
const admin='postgres://postgres@127.0.0.1:5433/postgres';

it('refuses simultaneous feature renderer intent before provisioning or worker fallback',async()=>{
 vi.stubEnv('AIHR_RESIGNATION_ROLE_MODE','resignation_browser_disposable');
 vi.stubEnv('AIHR_CONTRACT_ROLE_MODE','contract_browser_disposable');
 expect(()=>assertDisposableDraftDiscardFixture(admin)).toThrow('Explicit exclusive fictional browser binding required');
 await expect(ensureDraftDiscardTestRoles(admin)).rejects.toThrow('no worker fallback');
});

it.each(['AIHR_RESIGNATION_ROLE_UNRECOGNIZED','AIHR_CONTRACT_ROLE_UNRECOGNIZED'])('refuses abandoned partial %s intent instead of selecting another provisioning mode',async key=>{
 vi.stubEnv(key,'unexpected');
 expect(()=>assertDisposableDraftDiscardFixture(admin)).toThrow('Explicit exclusive');
 await expect(ensureDraftDiscardTestRoles(admin)).rejects.toThrow('no worker fallback');
});
