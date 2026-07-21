/**
 * Bootstrap invitation — mint the FIRST real login for a tenant, without an authenticated admin.
 *
 * WHY THIS EXISTS
 * ---------------
 * Turning on real WorkOS auth is a one-way door with a chicken-and-egg problem in the middle:
 *
 *   1. getSession() resolves a WorkOS subject through app.principal_by_subject(). No matching
 *      app_user ⇒ AuthRequiredError ⇒ redirect to /login.
 *   2. Every seeded app_user carries a PLACEHOLDER subject ('user_dev_admin', 'seed:…@demo.test'),
 *      which no real WorkOS session will ever present.
 *   3. The normal way to bind a real subject is an invitation — but core/auth.ts inviteUser() calls
 *      assertGroupAdmin(ctx), so it needs an admin who is *already* logged in.
 *
 * So the moment ALLOW_DEMO_SESSION is unset, nobody can get in and nobody can be invited in. This
 * script breaks that cycle exactly once, then normal invitations take over.
 *
 * HOW IT BINDS (no new binding logic — it reuses the tested path)
 * --------------------------------------------------------------
 * It writes ONLY an app_invitation row. The actual subject binding is still done by
 * app.consume_invitation (db/migrations/0151_real_auth_workos.sql:124), reached when the invitee
 * opens /invite/<token> after authenticating with WorkOS. Because we set person_id, that function
 * takes its "person already has an app_user" branch and does:
 *
 *     UPDATE app_user SET workos_user_id = <real subject> WHERE id = <existing user>
 *
 * i.e. it REBINDS the existing seeded user to the real subject, preserving its id, its person link,
 * and everything that references it. Single-use and expiring, enforced by that same function.
 *
 * SAFETY
 * ------
 * • Runs against MIGRATION_DATABASE_URL (owner role) because there is no session to authorise it —
 *   that is the whole point. Treat it like a migration: operator-run, on the box, deliberately.
 * • Prints the raw token ONCE. Only its sha256 is stored, exactly as inviteUser does, so a leaked
 *   database dump does not yield a usable invitation.
 * • Appends an app-user.invited domain event with actor 'system' so a bootstrap is never silent.
 * • Refuses if the target person has no app_user — that case would CREATE a user rather than rebind
 *   one, which is not what a bootstrap should quietly do.
 *
 * USAGE (on the server, before unsetting ALLOW_DEMO_SESSION)
 *   node --import tsx scripts/auth/bootstrap-invite.ts \
 *     --email you@company.com --person-id <uuid> [--role hr_admin] [--company-id <uuid>] \
 *     [--base-url https://demo.example.com]
 *
 * Then: sign up / log in at WorkOS with that same email, open the printed /invite/<token> URL, and
 * your real subject replaces the placeholder. Verify with:
 *   select workos_user_id from app_user where person_id = '<uuid>';
 */
import { createHash, randomBytes } from 'node:crypto';
import postgres from 'postgres';

const INVITE_TTL_DAYS = 7; // mirrors core/auth.ts INVITE_TTL_DAYS

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function main() {
  try {
    process.loadEnvFile('.env.production');
  } catch {
    try {
      process.loadEnvFile('.env.local');
    } catch {
      // env supplied directly
    }
  }

  const email = arg('email')?.trim().toLowerCase();
  const personId = arg('person-id');
  const role = arg('role') ?? 'hr_admin';
  const companyId = arg('company-id') ?? null;
  const baseUrl = (arg('base-url') ?? process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
  const url = process.env.MIGRATION_DATABASE_URL;

  if (!email || !email.includes('@')) fail('--email <address> is required.');
  if (!personId) fail('--person-id <uuid> is required. Find it with: select id, full_name from person;');
  if (!url) fail('MIGRATION_DATABASE_URL is not set (run this from /opt/ai-hr on the server).');

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // The target must ALREADY have an app_user, otherwise consume_invitation would create a second
    // one instead of rebinding — a silent duplicate identity, which is the opposite of a bootstrap.
    const existing = await sql<{ app_user_id: string; tenant_id: string; workos_user_id: string }[]>`
      select u.id as app_user_id, u.tenant_id, u.workos_user_id
        from app_user u
       where u.person_id = ${personId}::uuid
       limit 1
    `;
    const target = existing[0];
    if (!target) {
      fail(
        `No app_user is linked to person ${personId}. A bootstrap invitation must REBIND an existing ` +
          `user, not create one. Pick a person who already has a login, or invite normally once you are in.`,
      );
    }

    const raw = randomBytes(32).toString('base64url'); // matches core/auth.ts newRawToken
    const tokenHash = createHash('sha256').update(raw, 'utf8').digest('hex');

    const [inv] = await sql<{ id: string }[]>`
      insert into app_invitation
        (tenant_id, company_id, email, role, person_id, token_hash, status, expires_at, created_by)
      values
        (${target.tenant_id}::uuid, ${companyId}::uuid, ${email}, ${role}, ${personId}::uuid,
         ${tokenHash}, 'pending', now() + (${INVITE_TTL_DAYS} || ' days')::interval, null)
      returning id
    `;

    // Never silent: a bootstrap bypasses the admin gate, so it must be on the record. Raw token is
    // deliberately NOT in the payload (same rule as inviteUser).
    await sql`
      insert into domain_event
        (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
      values
        (${target.tenant_id}::uuid, 'app-invitation', ${inv.id}::uuid, 'app-user.invited',
         'system', null,
         ${sql.json({ email, role, companyId, personId, bootstrap: true, via: 'bootstrap-invite' })})
    `;

    const link = baseUrl ? `${baseUrl}/invite/${raw}` : `/invite/${raw}`;
    console.log('\n✓ Bootstrap invitation created.\n');
    console.log(`  rebinds app_user : ${target.app_user_id}`);
    console.log(`  current subject  : ${target.workos_user_id}   ← placeholder, will be replaced`);
    console.log(`  email            : ${email}`);
    console.log(`  role granted     : ${role}${companyId ? ` (company ${companyId})` : ' (group-wide)'}`);
    console.log(`  expires          : ${INVITE_TTL_DAYS} days\n`);
    console.log(`  OPEN THIS ONCE, signed in to WorkOS as ${email}:\n`);
    console.log(`  ${link}\n`);
    if (!baseUrl) console.log('  (pass --base-url https://your-host to get a full URL)\n');
    console.log('  Shown once — only its hash is stored. Re-run to mint a new one.\n');
    console.log(`  Verify after:  select workos_user_id from app_user where id = '${target.app_user_id}';\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
