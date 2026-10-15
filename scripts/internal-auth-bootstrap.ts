import postgres from 'postgres';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { bootstrapInternalOwner } from '../lib/internal-auth/bootstrap';
import { internalConfig } from '../lib/internal-auth/config';
async function main() {
if (process.getuid?.() !== 0) throw new Error('Run through the installation administrator.');
const config = internalConfig();
const args = new Map(process.argv.slice(2).map(value => { const at = value.indexOf('='); return at < 0 ? [value, 'true'] : [value.slice(0, at), value.slice(at + 1)]; }));
if (!args.has('--password-stdin')) throw new Error('Provide the temporary password on stdin, never in argv or the environment.');
const chunks: Buffer[] = []; let size = 0;
for await (const chunk of process.stdin) { size += chunk.length; if (size > 1024) throw new Error('Password input too large.'); chunks.push(Buffer.from(chunk)); }
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
const connection = process.env.MIGRATION_DATABASE_URL;
if (!connection) throw new Error('Migration connection is required for the audited bootstrap.');
const db = postgres(connection, { max: 1, onnotice: () => {} });
try {
  let invitationToken: string | undefined;
  const activationFile = args.get('--activation-file');
  if (activationFile) {
    if (!isAbsolute(activationFile)) throw new Error('Use an absolute private activation file.');
    const file = await open(activationFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== 0 || (info.mode & 0o077) !== 0 || info.size > 4096) throw new Error('Private activation file required.');
      const url = new URL((await file.readFile('utf8')).trim());
      const match = /^\/invite\/([A-Za-z0-9_-]{43})(?:\/activate)?$/.exec(url.pathname);
      if (!match || url.origin !== config.origin || url.username || url.password || url.search || url.hash) throw new Error('Invalid private activation file.');
      invitationToken = match[1];
    } finally { await file.close(); }
  }
  const result = await bootstrapInternalOwner(db, { appUserId: args.get('--app-user-id') || '', organization: args.get('--organization') || '',
    username: args.get('--username') || '', email: args.get('--email') || '', password, installationOperator: args.has('--installation-owner'), invitationToken });
  console.log(result.alreadyEnrolled ? 'The exact owner is already enrolled. No password, MFA or grants were changed.' : 'Owner enrolled on the existing HR user. First sign-in requires a new password and authenticator setup.');
} catch { console.error('Owner bootstrap refused or failed. Review organization ownership, exact HR administrator ID and password policy. No credentials are printed.'); process.exitCode = 1; }
finally { await db.end(); await (await import('../db/client')).client.end({ timeout: 5 }); }
}
main().then(() => process.exit(process.exitCode || 0), () => { console.error('Owner bootstrap refused. Check the reviewed private configuration and installation administrator access. No credential details are printed.'); process.exit(1); });
