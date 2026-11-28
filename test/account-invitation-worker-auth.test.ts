/**
 * "By Batch Send Invitation" (bulk_job_kind account_invitation_batch) runs in the import worker, which reads only
 * /etc/aihr/import-worker.env. On staging (28 November 2026) that file had no AUTH_* settings, so the worker did not
 * select embedded login, account email readiness asked the legacy Keycloak relay socket (never installed with
 * AUTH_PROVIDER=internal) and every invitation failed with "The email service is not available".
 * Synthetic key material and a fictional origin only.
 */
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,describe,expect,it,vi} from 'vitest';

const recoveryMailReady=vi.hoisted(()=>vi.fn(async()=>true));
vi.mock('../lib/internal-auth/mail',()=>({
 internalEmailRequest:async(request:{op:string})=>{if(request.op!=='readiness')throw new Error('unexpected');return {ready:await recoveryMailReady()};},
}));

import {accountEmailReadiness} from '../lib/identity/account-email-readiness';
import {WORKER_INTERNAL_AUTH_KEYS,workerInternalAuthWarning} from '../lib/internal-auth/worker-environment';

const KEY='b2'.repeat(32);
const ORIGIN='https://hr.example.test';
const internal={AUTH_PROVIDER:'internal',AUTH_PUBLIC_ORIGIN:ORIGIN,AUTH_SESSION_KEY:KEY};

afterEach(()=>{vi.unstubAllEnvs();recoveryMailReady.mockReset();recoveryMailReady.mockImplementation(async()=>true);});

describe('batch account invitations in the import worker',()=>{
 it('without the web internal-auth settings, readiness asks the absent legacy relay and reports the observed failure',async()=>{
  vi.stubEnv('AUTH_PROVIDER','');vi.stubEnv('AUTH_PUBLIC_ORIGIN','');vi.stubEnv('AUTH_SESSION_KEY','');
  vi.stubEnv('IDENTITY_EMAIL_SOCKET',join(tmpdir(),`aihr-absent-relay-${process.pid}.sock`));
  expect(await accountEmailReadiness()).toBe('relayUnavailable');
  expect(recoveryMailReady).not.toHaveBeenCalled();
 });

 it('with the web internal-auth settings, readiness uses the HR-owned SMTP settings and never the relay socket',async()=>{
  for(const [key,value] of Object.entries(internal))vi.stubEnv(key,value);
  vi.stubEnv('IDENTITY_EMAIL_SOCKET',join(tmpdir(),`aihr-absent-relay-${process.pid}.sock`));
  expect(await accountEmailReadiness()).toBeNull();
  expect(recoveryMailReady).toHaveBeenCalledTimes(1);
  // No active SMTP connection yet: held as relayUnavailable until an operator activates a tested connection.
  recoveryMailReady.mockImplementation(async()=>false);
  expect(await accountEmailReadiness()).toBe('relayUnavailable');
  // Selected but misconfigured (for example a truncated key copy): the sign-in service, not the relay, is at fault.
  vi.stubEnv('AUTH_SESSION_KEY',KEY.slice(1));recoveryMailReady.mockImplementation(async()=>true);
  expect(await accountEmailReadiness()).toBe('providerUnavailable');
 });

 it('warns at worker startup unless all three settings are present and valid, without printing a value',()=>{
  expect(workerInternalAuthWarning(internal)).toBeNull();
  const cases:Record<string,string|undefined>[]=[{},{...internal,AUTH_PROVIDER:undefined},{...internal,AUTH_PROVIDER:'keycloak'},
   {...internal,AUTH_PUBLIC_ORIGIN:undefined},{...internal,AUTH_PUBLIC_ORIGIN:'http://hr.example.test'},
   {...internal,AUTH_SESSION_KEY:undefined},{...internal,AUTH_SESSION_KEY:KEY.slice(2)}];
  for(const env of cases){
   const warning=workerInternalAuthWarning(env);
   expect(warning).toContain('The email service is not available');
   expect(warning).toContain('/etc/aihr/import-worker.env');
   expect(warning).not.toContain(KEY);expect(warning).not.toContain(KEY.slice(2));expect(warning).not.toContain(ORIGIN);
  }
 });

 it('lets the reviewed worker installer carry exactly these settings into the worker environment',()=>{
  const code="import importlib.util,json,sys;s=importlib.util.spec_from_file_location('v2',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(sorted(m.ENV_KEYS)))";
  const result=spawnSync('python3',['-I','-B','-c',code,'deploy/systemd/bank_import_worker_installer_v2.py'],{encoding:'utf8'});
  expect(result.status,result.stderr).toBe(0);
  const keys=JSON.parse(result.stdout) as string[];
  for(const key of WORKER_INTERNAL_AUTH_KEYS)expect(keys).toContain(key);
  // The worker never receives the legacy Keycloak service credential or the demo switch.
  for(const key of ['KEYCLOAK_ADMIN_CLIENT_SECRET','KEYCLOAK_ADMIN_CLIENT_ID','ALLOW_DEMO_SESSION','WORKOS_API_KEY'])expect(keys).not.toContain(key);
 });
});
