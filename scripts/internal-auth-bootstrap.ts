import postgres from 'postgres';
import { bootstrapInternalOwner } from '../lib/internal-auth/bootstrap';
import { internalConfig } from '../lib/internal-auth/config';
if (process.getuid?.() !== 0) throw new Error('Run through the installation administrator.');
internalConfig();
const args = new Map(process.argv.slice(2).map(value => { const at = value.indexOf('='); return at < 0 ? [value, 'true'] : [value.slice(0, at), value.slice(at + 1)]; }));
if (!args.has('--password-stdin')) throw new Error('Provide the temporary password on stdin, never in argv or the environment.');
const chunks: Buffer[] = []; let size = 0;
for await (const chunk of process.stdin) { size += chunk.length; if (size > 1024) throw new Error('Password input too large.'); chunks.push(Buffer.from(chunk)); }
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
const connection = process.env.MIGRATION_DATABASE_URL;
if (!connection) throw new Error('Migration connection is required for the audited bootstrap.');
const db = postgres(connection, { max: 1, onnotice: () => {} });
try {
  const result = await bootstrapInternalOwner(db, { appUserId: args.get('--app-user-id') || '', organization: args.get('--organization') || '',
    username: args.get('--username') || '', email: args.get('--email') || '', password, installationOperator: args.has('--installation-owner') });
  console.log(result.alreadyEnrolled ? 'The exact owner is already enrolled. No password, MFA or grants were changed.' : 'Owner enrolled on the existing HR user. First sign-in requires a new password and authenticator setup.');
} catch { console.error('Owner bootstrap refused or failed. Review organization ownership, exact HR administrator ID and password policy. No credentials are printed.'); process.exitCode = 1; }
finally { await db.end(); }
