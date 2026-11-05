// Deploy preflight: the review and notification sweeps project through the MIGRATION_DATABASE_URL login and
// downgrade to ai_hr_app with SET LOCAL ROLE. PostgreSQL 16 refuses that unless the login holds a SET TRUE
// edge to ai_hr_app, and only an installation DBA can grant it. Staging ran without it from 25 October 2026:
// the 03:00 review sweep exited 1 every night and the minute notification sweep failed whenever events were
// pending. Refuse here, before anything is installed, built or migrated, instead of at 03:00.
// Exit 0 ready; 1 missing edge; 2 could not check.
import { createDb } from '../db/client';
import { NOTIFICATION_ROLE_PREREQUISITE, notificationDowngradeReady } from './lib/notification-sweep-role';

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('✗ check:notification-role needs MIGRATION_DATABASE_URL (the login the sweeps use) — load .env.production.');
    process.exit(2);
  }
  const owner = createDb(url, { max: 1 });
  let ready = false;
  try {
    ready = await notificationDowngradeReady(owner.db);
  } catch (e) {
    console.error(`✗ check:notification-role could not read the role catalog: ${(e as Error).name}`);
    await owner.client.end();
    process.exit(2);
  }
  await owner.client.end();
  if (!ready) {
    console.error('✗ The sweep login cannot SET ROLE ai_hr_app, so notification projection fails in every sweep.');
    console.error(`  An installation DBA must run ${NOTIFICATION_ROLE_PREREQUISITE} (one INHERIT FALSE/SET TRUE grant), then re-run.`);
    process.exit(1);
  }
  console.log('✓ Sweep login can downgrade to ai_hr_app for notification projection.');
}

main().catch((e) => {
  console.error(`✗ check:notification-role failed: ${(e as Error).name}`);
  process.exit(2);
});
