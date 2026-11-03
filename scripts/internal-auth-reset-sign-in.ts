import postgres from 'postgres';
import { previewSignInReset, resetSignIn } from '../lib/internal-auth/operator-reset';
import { internalConfig } from '../lib/internal-auth/config';
async function main() {
if (process.getuid?.() !== 0) throw new Error('Run through the installation administrator.');
internalConfig();
const args = new Map(process.argv.slice(2).map(value => { const at = value.indexOf('='); return at < 0 ? [value, 'true'] : [value.slice(0, at), value.slice(at + 1)]; }));
const login = { organization: args.get('--organization') || '', username: args.get('--username') || '' };
const connection = process.env.MIGRATION_DATABASE_URL;
if (!connection) throw new Error('Migration connection is required for the audited reset.');
let password = '';
if (!args.has('--preview')) {
  if (!args.has('--password-stdin')) throw new Error('Provide the temporary password on stdin, never in argv or the environment.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 1024) throw new Error('Password input too large.'); chunks.push(Buffer.from(chunk)); }
  password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
const db = postgres(connection, { max: 1, onnotice: () => {} });
try {
  if (args.has('--preview')) {
    const preview = await previewSignInReset(db, login);
    console.log(`  Name:         ${preview.fullName ?? '(no linked person)'}`);
    console.log(`  Login:        ${preview.organization} / ${preview.username}`);
    console.log(`  Email:        ${preview.email}`);
    for (const grant of preview.grants) console.log(`  Role:         ${grant.role} · ${grant.company ?? 'Group-wide'}`);
    if (!preview.grants.length) console.log('  Role:         (none)');
    console.log(`  Confirmation: ${preview.confirmation}`);
  } else {
    await resetSignIn(db, { ...login, confirmation: args.get('--confirmation') || '', password });
    console.log('Sign-in reset. The next sign-in requires a new password and a new authenticator; all previous sessions and backup codes were removed.');
  }
} catch (error) {
  // Service refusals are written for the operator and never contain credential material.
  const message = error instanceof Error && /^(Invalid organization|No sign-in|This sign-in|The sign-in changed|The migration)/.test(error.message) ? error.message : null;
  const policy = (error as { code?: string })?.code === 'passwordPolicy';
  console.error(message ?? (policy ? 'The temporary password does not meet the organization password policy or was used before. Nothing was changed.'
    : 'Sign-in reset refused or failed. Nothing is printed about credentials.'));
  process.exitCode = 1;
}
finally { await db.end(); await (await import('../db/client')).client.end({ timeout: 5 }); }
}
main().then(() => process.exit(process.exitCode || 0), () => { console.error('Sign-in reset refused. Check the reviewed private configuration and installation administrator access. No credential details are printed.'); process.exit(1); });
