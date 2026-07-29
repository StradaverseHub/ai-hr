/**
 * Migration journal ordering guard (DB-free static check).
 *
 * WHY THIS EXISTS
 * ---------------
 * drizzle-kit's incremental migrator does NOT walk the journal blindly. It reads the single most recent
 * applied row once, up front:
 *
 *     select id, hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1
 *
 * ...then applies every journal entry whose `when` (folderMillis) is GREATER THAN that snapshot value.
 * The snapshot is taken once and never refreshed inside the loop.
 *
 * Two consequences:
 *   1. Within a SINGLE migrate run, ordering among the new entries does not matter — they are all compared
 *      against the same pre-run watermark. (This is why 0240, whose `when` is lower than 0230's, still
 *      applied during the R44 deploy: the pre-run watermark was 0219's 1781862218000, which both cleared.)
 *   2. Across SEPARATE runs it matters enormously. If a server has already applied an entry with a HIGH
 *      `when`, any later-added entry with a LOWER `when` is silently SKIPPED — no error, no warning. The
 *      migration simply never runs, and the failure surfaces later as a missing column in production.
 *
 * A fresh database never reproduces (2): with an empty bookkeeping table every entry clears the gate and
 * applies in journal order. That is exactly why this class of bug stays invisible to the test suite and the
 * clean-room gate, and only bites on a long-lived server. Hence this static guard.
 *
 * THE RULE: every entry's `when` must be strictly greater than the previous entry's.
 *
 * When adding a migration, set `when` strictly greater than the current maximum in this file. Parallel
 * feature branches are the common trap — two branches each picking a `when` relative to main will collide
 * or invert once merged. Re-check the ordering at integration time, before deploying.
 */
import { readFileSync } from 'node:fs';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const journal = JSON.parse(readFileSync(root + 'db/migrations/meta/_journal.json', 'utf8')) as {
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
};

/**
 * Grandfathered historical violation — DO NOT ADD TO THIS LIST.
 *
 * idx 240 (0240_employment_blacklist, when 1781862219000) sits below idx 230
 * (0230_delegation_scope_reason, when 1781862229000). Both shipped in the same R44 deploy, so both cleared
 * that run's pre-run watermark (0219's 1781862218000) and 0240 IS applied — verified against the demo
 * server: 230 journal entries vs 230 rows in drizzle.__drizzle_migrations, and employment.blacklisted_at /
 * blacklist_reason both exist.
 *
 * It is deliberately NOT re-stamped. Rewriting the `when` of an already-applied migration would leave the
 * journal permanently disagreeing with the created_at recorded in every migrated database, for zero
 * operational gain. The pair is inert; the rule below protects everything after it.
 */
const GRANDFATHERED_NON_ASCENDING = new Set<number>([240]);

describe('db/migrations/meta/_journal.json ordering', () => {
  it('has a strictly ascending `when` across all entries (guards the silent-skip bug)', () => {
    const violations: string[] = [];
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1]!;
      const cur = journal.entries[i]!;
      if (GRANDFATHERED_NON_ASCENDING.has(cur.idx)) continue;
      if (cur.when <= prev.when) {
        violations.push(
          `idx ${cur.idx} (${cur.tag}) when=${cur.when} is not greater than idx ${prev.idx} (${prev.tag}) when=${prev.when}`,
        );
      }
    }
    expect(
      violations,
      `Non-ascending migration \`when\` values will be SILENTLY SKIPPED by drizzle on any server that has ` +
        `already applied a later entry. Bump the offending \`when\` above the current journal maximum.\n` +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('has a strictly ascending idx', () => {
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i]!.idx, `idx must ascend at position ${i}`).toBeGreaterThan(
        journal.entries[i - 1]!.idx,
      );
    }
  });

  it('has a .sql file on disk for every entry, and no duplicate tags', () => {
    const seen = new Set<string>();
    for (const e of journal.entries) {
      expect(seen.has(e.tag), `duplicate tag ${e.tag}`).toBe(false);
      seen.add(e.tag);
      expect(
        existsSync(`${root}db/migrations/${e.tag}.sql`),
        `journal references ${e.tag} but db/migrations/${e.tag}.sql does not exist`,
      ).toBe(true);
    }
  });

  /**
   * THE OTHER DIRECTION, and it is the one that bites silently. The check above catches a journal entry
   * whose file is missing — which fails loudly the moment drizzle-kit tries to read it. This one catches a
   * .sql file that NO entry references: drizzle-kit iterates the JOURNAL, never the directory, so an
   * unreferenced migration is not "applied late", it is never applied at all. The file sits in the repo
   * looking shipped, every other test passes, and the table simply does not exist in production.
   *
   * Found in r79 when two branches both appended to _journal.json and the conflict resolution kept only
   * one side — 0323 vanished while 0323_feedback_block_answer.sql remained on disk. Nothing in the suite
   * noticed. This is the same silent-skip family as the ascending-`when` guard above, reached by a
   * different route: that one is a bad ordering, this one is a missing row.
   */
  it('has a journal entry for every .sql file on disk (guards a merge that drops an entry)', () => {
    const onDisk = readdirSync(`${root}db/migrations`)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.slice(0, -4))
      .sort();
    const inJournal = new Set(journal.entries.map((e) => e.tag));
    const orphans = onDisk.filter((tag) => !inJournal.has(tag));
    expect(
      orphans,
      `db/migrations/*.sql with no journal entry — drizzle-kit reads the journal, not the directory, so ` +
        `these would NEVER be applied: ${orphans.join(', ')}`,
    ).toEqual([]);
  });
});
