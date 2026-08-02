/**
 * The test-template fingerprint must cover the migration JOURNAL, not only the migration files.
 *
 * WHAT WENT WRONG (r111), because the shape of it is the whole point:
 *
 *   1. `0346_company_statutory_tier.sql` was added WITHOUT an entry in `db/migrations/meta/_journal.json`.
 *      drizzle applies what the JOURNAL lists — it never walks the directory — so the migration did not
 *      run. The fingerprint DID change (a new .sql file), so the template rebuilt: rebuilt correctly, and
 *      still without the column.
 *   2. The journal entry was then added. The fingerprint did NOT change, because the journal was not one
 *      of its inputs. `templateIsReusable` therefore answered TRUE and every worker was handed the same
 *      template — still missing the column.
 *
 * Step 2 is what makes this worth a guard. Step 1 alone is a mistake you make once and see immediately.
 * Step 2 means the OBVIOUS FIX APPEARS NOT TO WORK: the journal is correct, the .sql is correct, and the
 * suite still reports `column "statutory_tier" does not exist` from seedBase — which reads as a schema
 * bug in the code under test, not as a stale cache. Reruns keep failing identically.
 *
 * global-setup's own comment claims the fingerprint is "a hash of everything that determines the
 * template's SHAPE" and that "if the inputs are byte-identical the template cannot be stale". That
 * guarantee was FALSE while the journal sat outside the hash, and this file exists to keep it true.
 *
 * NOT A REGEX OVER global-setup.ts. The inputs are exported as data and asserted as data, so a refactor
 * that keeps the behaviour keeps this passing, and one that drops the journal fails.
 *
 * The sibling guard already exists and is NOT duplicated here:
 * test/migration-journal-ordering.test.ts asserts every .sql on disk has a journal entry (r79). That
 * catches step 1. Nothing caught step 2.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FINGERPRINT_EXTRA_FILES } from './global-setup';

describe('the template fingerprint covers everything that decides the schema', () => {
  it('includes the migration journal — the file that decides WHICH migrations run', () => {
    expect([...FINGERPRINT_EXTRA_FILES]).toContain('db/migrations/meta/_journal.json');
  });

  it('still includes packs/catalog.ts — the catalogs are code-seeded into the template', () => {
    expect([...FINGERPRINT_EXTRA_FILES]).toContain('packs/catalog.ts');
  });

  it('every declared input actually exists, so a rename cannot silently drop one from the hash', () => {
    // readFileSync would throw inside globalSetup, which is a confusing place to discover a typo.
    for (const f of FINGERPRINT_EXTRA_FILES) {
      expect(() => readFileSync(f), `${f} is hashed by templateFingerprint but is not readable`).not.toThrow();
    }
  });
});

describe('the journal genuinely changes the hash', () => {
  /**
   * A local re-implementation of templateFingerprint's algorithm, fed a SUBSTITUTED journal. This proves
   * the property behaviourally — that a journal edit moves the digest — rather than trusting that
   * including a filename in a list has the intended effect.
   */
  const digest = (journalOverride?: string): string => {
    const h = createHash('sha256');
    for (const f of readdirSync('db/migrations').sort()) {
      if (!f.endsWith('.sql')) continue;
      h.update(f).update(readFileSync(`db/migrations/${f}`));
    }
    for (const f of FINGERPRINT_EXTRA_FILES) {
      h.update(f).update(
        f === 'db/migrations/meta/_journal.json' && journalOverride !== undefined
          ? journalOverride
          : readFileSync(f),
      );
    }
    return h.digest('hex');
  };

  it('is stable when nothing changes', () => {
    expect(digest()).toBe(digest());
  });

  it('changes when the journal changes, with every .sql byte-identical', () => {
    // This is exactly the r111 step-2 scenario: the .sql files are untouched and only the journal moves.
    // Before r112 these two digests were EQUAL, which is what made the stale template look correct.
    const real = readFileSync('db/migrations/meta/_journal.json', 'utf8');
    const withOneMoreEntry = JSON.stringify({
      ...JSON.parse(real),
      entries: [
        ...JSON.parse(real).entries,
        { idx: 99999, version: '7', when: 9999999999999, tag: 'fixture_not_on_disk', breakpoints: true },
      ],
    });
    expect(withOneMoreEntry).not.toBe(real);
    expect(digest(withOneMoreEntry)).not.toBe(digest());
  });
});
