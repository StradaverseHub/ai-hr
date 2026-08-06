/**
 * 6e9a126e RELEASE THREE, migration 0409 — an entitlement eligibility rule is COMPANY-SCOPED ON WRITE.
 *
 * WHY THIS FILE EXISTS. Release three drops `leave_policy`, and with it migration 0134's deliberate
 * company-aware WITH CHECK: "a company-scoped admin may only write a policy for their own company; the
 * group default (company_id NULL) needs a group admin." The replacement table shipped in 0396 with only
 * `tenant_id = current_tenant AND app.is_admin()` — so for a while, release three's own diff was a
 * PRIVILEGE WIDENING: any admin could target any company, or every company at once, and the database
 * would not stop them. On a nine-company tenant that is not theoretical.
 *
 * 0409 restores the check. THIS FILE IS WHAT STOPS IT BEING LOST AGAIN, and every assertion here is a
 * REFUSAL — the happy path passing proves nothing about a boundary.
 *
 * The rule is expressed against `criteria` JSONB rather than a column, because that is where the new
 * layer keeps targeting:
 *   • criteria names companies ⇒ the writer must administer EVERY one of them
 *   • criteria names none      ⇒ the rule reaches the whole group ⇒ group admin only
 *
 * READ IS DELIBERATELY NOT SCOPED, and there is a test for that too: the accrual kernel resolves
 * entitlement under sessions that are not admin, and a read-side restriction would silently zero those
 * resolutions rather than refuse them — a wrong number instead of an error.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { createEntitlementTemplate } from '../core/entitlement-template';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

/** A REAL template lineage. Using a random uuid here made every insert die on the foreign key BEFORE it
 *  reached the RLS check — so the refusal tests passed for the wrong reason and proved nothing. That is
 *  the `rejects.toThrow()` trap this repo has recorded: a fixture failing earlier than the constraint
 *  under test. Every assertion below now genuinely reaches the policy. */
let lineageId: string;

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  lineageId = (
    await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'scope fixture',
      serviceBands: [{ fromYears: 0, toYears: null, days: 10 }],
      validFrom: '2026-01-01',
    })
  ).lineageId;
});
afterAll(async () => {
  await closeAll();
});

/** A SessionContext whose admin grant is limited to ONE company — the shape db/client.ts publishes as
 *  `app.grants`, which is what app.is_admin_for()/is_group_admin() actually read. Building it this way
 *  (rather than hand-rolling set_config) means the test exercises the SAME path production does. */
const scoped = (companyId: string): SessionContext => ({
  tenantId: b.tenantId,
  userId: b.adminUserId,
  roles: ['hr_admin'],
  grants: [{ role: 'hr_admin', companyId }],
});

/** A GROUP-wide admin: companyId null is what app.is_group_admin() requires. */
const group = (): SessionContext => ({
  tenantId: b.tenantId,
  userId: b.adminUserId,
  roles: ['hr_admin'],
  grants: [{ role: 'hr_admin', companyId: null }],
});

/** NOTE the TWO lineage columns: the rule's own `lineage_id` (its version chain) and
 *  `template_lineage_id` (which template it points at). Omitting the first made every ALLOW case die on
 *  NOT NULL *after* passing the policy, which read as "the policy refused a legitimate write" — the
 *  opposite of the truth and the sort of thing that gets a correct security fix reverted.
 *  Insert a rule through the app's own connection so RLS applies. Returns the error, or null on success. */
async function insertRuleAs(ctx: SessionContext, criteria: unknown): Promise<Error | null> {
  return withTenant(ctx, async (tx) => {
    await tx.execute(sql`
      insert into entitlement_eligibility_rule
        (tenant_id, lineage_id, name, template_lineage_id, criteria, valid_from)
      values (${b.tenantId}::uuid, ${randomUUID()}::uuid, ${'r-' + randomUUID().slice(0, 8)},
              ${lineageId}::uuid, ${JSON.stringify(criteria)}::jsonb, '2026-01-01')
    `);
  }).then(
    () => null,
    (e: Error) => e,
  );
}

/** A second company in the same tenant, so "another company" is a real row rather than a random uuid. */
async function otherCompany(): Promise<string> {
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: `Other ${randomUUID().slice(0, 6)}`, country: 'MY' })
    .returning({ id: schema.company.id });
  return c.id;
}

/** Drizzle wraps the PostgresError, so the RLS text lives in `cause`, not `message`. Asserting on the
 *  WRONG one is how a test claims to prove a refusal while actually catching a fixture error. */
const errText = (e: Error | null) =>
  [e?.message, (e as (Error & { cause?: Error }) | null)?.cause?.message].filter(Boolean).join(' | ');

describe('0409 — an eligibility rule is company-scoped on WRITE', () => {
  it('REFUSES a company-scoped admin writing a rule for a company they do not administer', async () => {
    const [mine, theirs] = [b.companyId, await otherCompany()];
    const err = await insertRuleAs(scoped(mine), { companyIds: [theirs] });
    expect(err, 'writing into another company must be refused').not.toBeNull();
    expect(errText(err), 'must be an RLS refusal, not some earlier fixture failure').toMatch(/row-level security|policy/i);
  });

  it('REFUSES a company-scoped admin writing a GROUP-WIDE rule (no companies named)', async () => {
    // The 0134 case this replaces: `company_id IS NULL` meant "the group default" and needed a group
    // admin. Empty criteria is the same claim — it reaches every company in the tenant.
    const err = await insertRuleAs(scoped(b.companyId), {});
    expect(err, 'an unscoped rule reaches every company and needs a group admin').not.toBeNull();
    expect(errText(err), 'must be an RLS refusal, not some earlier fixture failure').toMatch(/row-level security|policy/i);
  });

  it('REFUSES a rule naming SEVERAL companies when the admin administers only one of them', async () => {
    // The clause is NOT EXISTS(... WHERE NOT is_admin_for), so it must fail on ANY member, not just all.
    const theirs = await otherCompany();
    const err = await insertRuleAs(scoped(b.companyId), { companyIds: [b.companyId, theirs] });
    expect(err, 'one unadministered company in the list is enough to refuse').not.toBeNull();
  });

  it('ALLOWS a company-scoped admin writing a rule for their OWN company', async () => {
    const err = await insertRuleAs(scoped(b.companyId), { companyIds: [b.companyId] });
    expect(err, err ? `unexpectedly refused: ${err.message}` : '').toBeNull();
  });

  it('ALLOWS a group admin writing a group-wide rule', async () => {
    const err = await insertRuleAs(group(), {});
    expect(err, err ? `unexpectedly refused: ${err.message}` : '').toBeNull();
  });

  it('READ stays tenant-wide — the accrual kernel resolves entitlement under non-admin sessions', async () => {
    // Deliberately NOT scoped on read. A USING clause here would make a non-admin resolution return no
    // rows and silently compute a WRONG entitlement rather than raising — the worse failure of the two.
    await insertRuleAs(group(), {});
    const rows = await owner.db.execute(sql`select count(*)::int as n from entitlement_eligibility_rule`);
    expect((rows as unknown as { n: number }[])[0].n).toBeGreaterThan(0);
  });
});
