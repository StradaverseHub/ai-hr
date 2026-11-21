/** The additive capture migration changes only the mistaken address cap, preserving every installed guard. */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('restates the latest capture owner unchanged except for accepting more than eight resolved addresses', () => {
  const installed = readFileSync('db/migrations/5460_lifecycle_v9_email_recipients.sql', 'utf8');
  const start = installed.indexOf('CREATE OR REPLACE FUNCTION app.lc_v9_capture_mail()');
  const end = installed.indexOf('CREATE OR REPLACE FUNCTION app.lc_v9_email_target', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const expected = installed.slice(start, end).replace("jsonb_array_length(mail->'to') NOT BETWEEN 1 AND 8", "jsonb_array_length(mail->'to')<1");
  const migration = readFileSync('db/migrations/6104_lifecycle_recipient_fanout.sql', 'utf8');
  const actual = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION app.lc_v9_capture_mail()'));
  expect(actual).toBe(expected);
});
