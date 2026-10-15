/** Disposable local browser fixture only. Never imports a database until its destination is checked. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
const output = '/tmp/aihr-auth-experience/fixture.json';
function checked(name: string) {
  const url = new URL(process.env[name] || '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1','localhost'].includes(url.hostname) ||
    url.port !== '5433' || url.pathname !== '/ai_hr_internal_ui' || url.search || url.hash) throw new Error('Only the named disposable local authentication fixture database is allowed.');
  return url;
}
if (process.env.NODE_ENV === 'production' || process.env.AUTH_PROVIDER !== 'internal' || process.env.AUTH_PUBLIC_ORIGIN !== 'https://localhost:3543') throw new Error('Only the local HTTPS authentication fixture is allowed.');
checked('DATABASE_URL'); checked('MIGRATION_DATABASE_URL');
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.TEST_MIGRATION_DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
async function main() {
const { seedBase, owner, adminCtx, closeAll } = await import('../test/harness');
const { bootstrapInternalOwner } = await import('../lib/internal-auth/bootstrap');
const { changeInitialPassword, credentialByLogin, startLogin, verifyMfa, revokeSession } = await import('../lib/internal-auth/service');
const { generate } = await import('otplib');
const temporary = 'A synthetic private passphrase 771!', password = 'A different synthetic passphrase 883!';
try {
  const existing = await readFile(output, 'utf8').then(JSON.parse, () => null);
  if (existing) {
    const credential = await credentialByLogin('browser-cloud', 'owner');
    if (credential?.subject === existing.cloud.subject) {
      console.log('Existing isolated authentication fixture verified; no records changed.');
      return;
    }
    throw new Error('Remove the stale local fixture output only after recreating its disposable database.');
  }
  async function create(code: string, installationOperator: boolean) {
    const base = await seedBase();
    await owner.client`update company set legal_name=${installationOperator ? 'Cloud Authentication Fixture' : 'Private Authentication Fixture'} where id=${base.companyId}::uuid`;
    await bootstrapInternalOwner(owner.client, { appUserId: base.adminUserId, organization: code, username: 'owner', email: 'owner@example.test', password: temporary, installationOperator });
    const login = await startLogin({ organization: code, username: 'owner', password: temporary, native: false });
    if (login.step !== 'password') throw new Error('Expected initial password requirement.');
    const setup = await changeInitialPassword(login.challenge, password);
    if (setup.step !== 'enroll' || !setup.secret) throw new Error('Expected authenticator requirement.');
    const complete = await verifyMfa(setup.challenge, await generate({ secret: setup.secret }));
    if (complete.step !== 'complete') throw new Error('Expected full fixture session.');
    const credential = (await credentialByLogin(code, 'owner'))!;
    await revokeSession(complete.access_token);
    return { organization: code, username: 'owner', password, subject: credential.subject, tenantId: base.tenantId, userId: base.adminUserId,
      personId: null, secret: setup.secret, recoveryCodes: complete.recoveryCodes, companyId: base.companyId, departmentId: base.deptA };
  }
  const cloud = await create('browser-cloud', true), onPrem = await create('browser-private', false);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify({ notice: 'DISPOSABLE LOCAL SYNTHETIC ACCOUNTS ONLY. Never use these passwords outside this fixture.', cloud, onPrem }, null, 2), { mode: 0o600, flag: 'wx' });
  console.log('Created two isolated organization login fixtures; private synthetic details are in the local fixture file.');
} finally { await closeAll(); }
}
main().then(() => process.exit(0), () => { console.error('Isolated authentication fixture failed.'); process.exit(1); });
