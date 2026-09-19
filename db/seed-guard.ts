/**
 * r290 / readiness 1.1 — the demo seeder's refusal to run against somebody's real database.
 *
 * `db/seed.ts` opens with `TRUNCATE tenant, company, person, employment, … CASCADE` and then plants a
 * fixed fictional tenant called "Demo Group". Run once against a customer's database it destroys every
 * employee record in it; run against an EMPTY customer database it silently installs demo data as that
 * customer's first tenant. Until this file there was no refusal of any kind — the only thing standing
 * between a customer and that TRUNCATE was `deploy/deploy.sh` choosing not to call the seeder, and it
 * called the seeder precisely when the demo tenant row was ABSENT, which on a fresh customer database
 * is always.
 *
 * WHICH SIGNAL SAYS "THIS IS SOMEBODY'S REAL DATABASE"
 *
 * The survey proposed `NODE_ENV=production && ALLOW_DEMO_SESSION unset`. That is necessary and it is
 * kept below (R2), but on its own it is worth very little, for a reason worth naming: the gated demo
 * box and a customer box that copied the demo env template are, in the environment, THE SAME
 * DEPLOYMENT. Both carry `NODE_ENV=production` and `ALLOW_DEMO_SESSION=true`; nothing in the process
 * environment distinguishes them. A guard built only out of env vars is therefore satisfiable by
 * accident — by the single most likely operator mistake there is, copying the wrong example file.
 *
 * So the refusal is layered, and the layers are deliberately of different KINDS:
 *
 *   R1  REAL AUTHENTICATION IS CONFIGURED — any non-empty `WORKOS_*` variable.
 *       A deployment that has done the WorkOS cutover (readiness 1.3) authenticates real people. No
 *       demo deployment has ever had a WORKOS_* key (the gated box has none, `.env.example` has none,
 *       `deploy/.env.production.example` has none). This one OVERRIDES the demo flag: `ALLOW_DEMO_SESSION`
 *       cannot buy you back the right to truncate a database that real users sign in to.
 *
 *   R2  THIS IS A DEPLOYMENT AND IT DOES NOT DECLARE ITSELF THE GATED DEMO —
 *       `NODE_ENV === 'production'` and `ALLOW_DEMO_SESSION !== 'true'`.
 *       `NODE_ENV=production` is what separates a deployment from a workstation: every production env
 *       template sets it and `next start` needs it, while `.env.local` / `.env.example` do not set it
 *       at all, so `pnpm db:seed` on a developer's machine is untouched. `ALLOW_DEMO_SESSION === 'true'`
 *       is an EXACT string test, not truthiness: `ALLOW_DEMO_SESSION=false` is a refusal, which is the
 *       opposite of how the `AUDIT_HASH_CHAIN_ENABLED` truthiness bug went (ADR-0077 slice 3).
 *       Absence refuses. A customer following the customer runbook never sets this variable, and the
 *       customer env template (`deploy/.env.customer.example`) does not contain it.
 *
 *   R3  THE DEMO IDENTITY IS MISCONFIGURED — `DEV_TENANT_ID` set to anything but the id this file
 *       hardcodes. `deploy/deploy.sh` decides "has the demo already been seeded?" by looking for
 *       `DEV_TENANT_ID` in `tenant`, while the seeder always writes `DEMO_TENANT_ID`. If the two
 *       disagree the lookup can never succeed and the seeder — i.e. the TRUNCATE — runs on EVERY
 *       deploy. That is a data-loss bug on the demo box itself, not only on a customer's.
 *
 *   R4  THE DATABASE ALREADY HOLDS SOMEBODY ELSE'S DATA — a `tenant` row that is not the demo tenant.
 *       This is the only signal that is about the DATABASE rather than about a file an operator may
 *       have copied, and it is what makes R2 non-vacuous: a customer who copied the demo template gets
 *       past R2, but from the moment their database holds one real tenant the seeder refuses anyway.
 *       Checked inside the seeder against the live database, immediately before the TRUNCATE.
 *
 * THE RESIDUAL GAP, stated rather than hidden: a customer who copies the DEMO env template AND runs
 * the DEMO deploy path against an EMPTY database is, by construction, indistinguishable from the demo
 * box and still gets Demo Group. No env-var guard can close that, because there is nothing left to
 * read. It is closed structurally instead — `deploy/deploy-customer.sh` / `deploy.sh --customer` never
 * reach the seeder, `deploy.sh` only seeds when the environment says `ALLOW_DEMO_SESSION=true`, and
 * `deploy/DEPLOY.md` sends a customer to a template that has no demo variables in it.
 *
 * Every refusal is a hard non-zero exit with a message that names the signal it fired on. None of them
 * is a warning: a warning in a deploy log is read after the TRUNCATE, not before.
 */

/** The tenant id `db/seed.ts` writes. `deploy/deploy.sh` must look for exactly this id. */
export const DEMO_TENANT_ID = '11111111-1111-1111-1111-111111111111';

/**
 * The reserved system tenant that migration 0151 inserts on EVERY database, demo and customer alike.
 *
 * It is not anybody's data and cannot become anybody's data: `domain_event.tenant_id` is NOT NULL with
 * an FK to `tenant`, and pre-auth auth events (login-failed on an un-invited email, a reset request for
 * an unknown email) have no tenant to stamp — so `app.append_auth_event` COALESCEs them onto this
 * nil-uuid row. By construction it holds no companies, people or employments, which is what makes RLS
 * on every tenant-scoped table exclude it naturally.
 *
 * ⚠️ IT IS THEREFORE NOT A SIGNAL, AND TREATING IT AS ONE MADE R4 WORSE, NOT SAFER. Because 0151 runs
 * on every correctly migrated database, R4 fired on ALL of them — a developer could not seed a freshly
 * rebuilt local cluster without `SEED_MAY_DESTROY_OTHER_TENANTS=1`. A guard that is always tripped
 * teaches the operator to type the override by reflex, and the override is the one thing standing
 * between a real database and the TRUNCATE. The refusal is worth more when it means something.
 */
export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** Escape hatch for R4 only, and deliberately in no template, runbook or example file. */
export const DESTROY_OVERRIDE = 'SEED_MAY_DESTROY_OTHER_TENANTS';

export type SeedEnv = Record<string, string | undefined>;

const BANNER = 'REFUSING TO SEED';

function refusal(signal: string, body: string[]): string {
  return [
    '',
    `✗ ${BANNER}: ${signal}`,
    ...body.map((l) => `  ${l}`),
    '  db/seed.ts TRUNCATEs tenant, company, person, employment and 20 other tables before it writes',
    '  anything. It is a DEMO fixture for a developer machine or the gated consultant box. It is never',
    '  part of a customer deployment — see deploy/DEPLOY.md, "Deploying for a customer".',
    '',
  ].join('\n');
}

/** Non-empty `WORKOS_*` keys present in `env`, sorted. R1's evidence. */
export function realAuthKeys(env: SeedEnv): string[] {
  return Object.keys(env)
    .filter((k) => k.startsWith('WORKOS_') && (env[k] ?? '').trim() !== '')
    .sort();
}

/**
 * R1–R3: everything decidable from the environment alone, before a connection is opened.
 * Returns the refusal message, or `null` when seeding is allowed to proceed to R4.
 */
export function demoSeedRefusal(env: SeedEnv): string | null {
  const workos = realAuthKeys(env);
  if (workos.length > 0) {
    return refusal('this deployment has real authentication configured.', [
      `Found: ${workos.join(', ')}.`,
      'A deployment that signs real people in through WorkOS is somebody\'s real deployment.',
      `ALLOW_DEMO_SESSION does NOT override this — unset the WORKOS_* keys if this really is a demo.`,
    ]);
  }

  if (env.NODE_ENV === 'production' && env.ALLOW_DEMO_SESSION !== 'true') {
    return refusal('this is a production deployment that has not declared itself a demo.', [
      `NODE_ENV=production and ALLOW_DEMO_SESSION is ${env.ALLOW_DEMO_SESSION === undefined ? 'unset' : `'${env.ALLOW_DEMO_SESSION}'`} (the gated demo sets exactly 'true').`,
      'If this is a customer deployment, nothing is wrong except that the seeder was invoked at all:',
      'deploy with ./deploy/deploy-customer.sh, which cannot reach this file.',
    ]);
  }

  if (env.DEV_TENANT_ID !== undefined && env.DEV_TENANT_ID !== DEMO_TENANT_ID) {
    return refusal('DEV_TENANT_ID does not match the tenant this seeder writes.', [
      `DEV_TENANT_ID=${env.DEV_TENANT_ID}`,
      `db/seed.ts writes ${DEMO_TENANT_ID}`,
      'deploy/deploy.sh decides whether the demo is already seeded by looking DEV_TENANT_ID up in',
      'tenant. While these disagree that lookup can never succeed, so the seeder — and its TRUNCATE —',
      'would run on EVERY deploy. Fix .env.production rather than removing this check.',
    ]);
  }

  return null;
}

/**
 * R4: decided from the live database, immediately before the TRUNCATE. `tenants` is every row of
 * `tenant` in the target database. Returns the refusal message, or `null` when only the demo tenant,
 * the reserved system tenant (see SYSTEM_TENANT_ID — it is on every database and says nothing about
 * whose database this is), or nothing at all is present.
 *
 * Everything else still refuses. One real tenant alongside the system row is a refusal, which is what
 * keeps this check the non-vacuous half of the guard: a customer who copied the demo env template gets
 * past R1-R3, and is stopped here from the moment their database holds one tenant of their own.
 */
export function foreignTenantRefusal(
  tenants: ReadonlyArray<{ id: string; name: string | null }>,
  env: SeedEnv,
): string | null {
  const foreign = tenants.filter((t) => t.id !== DEMO_TENANT_ID && t.id !== SYSTEM_TENANT_ID);
  if (foreign.length === 0) return null;
  if (env[DESTROY_OVERRIDE] === '1') return null;

  return refusal(`the target database already holds ${foreign.length} tenant(s) this seeder did not create.`, [
    ...foreign.slice(0, 10).map((t) => `${t.id}  ${t.name ?? '(unnamed)'}`),
    ...(foreign.length > 10 ? [`… and ${foreign.length - 10} more`] : []),
    'Truncating would destroy them and every employee, payslip and leave record underneath them.',
    `If that is genuinely what you want, re-run with ${DESTROY_OVERRIDE}=1.`,
  ]);
}
