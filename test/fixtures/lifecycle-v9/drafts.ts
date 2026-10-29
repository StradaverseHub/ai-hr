import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
/** Disposable-worker overlay only. Replace this with the allocated canonical migration at release.
 * Separate fixture receipts never masquerade as entries in the canonical Drizzle ledger. */
export async function installLifecycleV9Drafts(client: Sql) {
  if (process.env.VITEST !== 'true') throw Error('V9 draft overlay requires the test runner');
  const expected = new URL(process.env.TEST_MIGRATION_DATABASE_URL!).pathname.slice(1);
  await client.begin(async tx => {
    if ((await tx`select current_database() as name`)[0].name !== expected) throw Error('V9 draft overlay requires the exact test database');
    await tx`select pg_advisory_xact_lock(hashtext('v9-test-draft-overlay'))`;
    await tx.unsafe('CREATE SCHEMA IF NOT EXISTS v9_test_fixture; REVOKE ALL ON SCHEMA v9_test_fixture FROM PUBLIC; CREATE TABLE IF NOT EXISTS v9_test_fixture.draft_receipt(name text PRIMARY KEY,hash text NOT NULL); REVOKE ALL ON v9_test_fixture.draft_receipt FROM PUBLIC;');
    for (const [name,table] of [['lifecycle-v9.sql','lc_v9_case'],['lifecycle-v9-email.sql','lc_v9_email_delivery'],['lifecycle-v9-email-assets.sql','lc_v9_email_asset'],['lifecycle-v9-events.sql','app.lc_v9_capture_source_runs'],['lifecycle-v9-delivery-review.sql','app.lc_v9_email_retryable'],['lifecycle-v9-employment-class.sql','app.lc_v9_employment_class'],['lifecycle-v9-business-recipients.sql','app.lc_v9_literal_address']]) {
      const source = readFileSync('db/migration-drafts/'+name,'utf8'), hash = createHash('sha256').update(source).digest('hex');
      const [receipt] = await tx`select hash from v9_test_fixture.draft_receipt where name=${name}`;
      const present = name === 'lifecycle-v9-business-recipients.sql' ? (await tx`select to_regprocedure('app.lc_v9_literal_address(text)') as name`)[0].name : name === 'lifecycle-v9-employment-class.sql' ? (await tx`select to_regprocedure('app.lc_v9_employment_class(jsonb)') as name`)[0].name : name === 'lifecycle-v9-delivery-review.sql' ? (await tx`select to_regprocedure('app.lc_v9_email_retryable(uuid,text)') as name`)[0].name : name === 'lifecycle-v9-events.sql' ? (await tx`select to_regprocedure('app.lc_v9_capture_source_runs(uuid,text,jsonb,jsonb,jsonb,integer)') as name`)[0].name : (await tx`select to_regclass(${'public.'+table}) as name`)[0].name;
      if (receipt) { if (receipt.hash !== hash || !present) throw Error('V9 test draft receipt differs; use a fresh disposable worker database'); continue; }
      if (present) throw Error('Unreceipted V9 draft exists; use a fresh disposable worker database');
      await tx.unsafe(source); await tx`insert into v9_test_fixture.draft_receipt(name,hash) values(${name},${hash})`;
    }
  });
}
