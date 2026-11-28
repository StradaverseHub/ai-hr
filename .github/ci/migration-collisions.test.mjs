import assert from 'node:assert/strict';
import test from 'node:test';
import {addedEntries, migrationCollisions, migrationNumber, nextFreeSlot} from './check-migration-collisions.mjs';

const e = (number, name, offset = 0) => ({idx: number + 3400 + offset, when: 1795495000000 + number + offset, tag: `${number}_${name}`});
const main = [e(7200, 'information_documents'), e(7210, 'access_effective_company')];

test('reads the migration number from the tag', () => {
  assert.equal(migrationNumber('7260_viewer_access_version'), 7260);
  assert.equal(migrationNumber('meta'), null);
});

test('a fresh slot above main and unused elsewhere passes', () => {
  const result = migrationCollisions({base: main, mine: [...main, e(7220, 'movement')], others: []});
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.added.map(entry => entry.tag), ['7220_movement']);
});

test('reusing a number already on main fails, even with a new idx and when', () => {
  const result = migrationCollisions({base: main, mine: [...main, {idx: 99999, when: 1799999999999, tag: '7210_movement'}]});
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /reuses the number of 7210_access_effective_company .* on main/);
});

test('a when at or below main\'s highest fails, as an installation with main would skip it', () => {
  const result = migrationCollisions({base: main, mine: [...main, {idx: 20000, when: main[1].when - 5, tag: '7299_late'}]});
  assert.ok(result.errors.some(error => /at or below main's highest/.test(error)));
});

test('two open PRs on the same slot: the later one fails, the earlier one only warns (7260, 25 Nov 2026)', () => {
  const phase3 = {ref: '#302', openedAt: '2026-11-25T00:42:00Z', entries: [...main, e(7260, 'viewer_access_version')]};
  const leave = {ref: '#305', openedAt: '2026-11-25T01:02:00Z', entries: [...main, e(7260, 'leave_delegated_decision_set')]};
  const later = migrationCollisions({base: main, mine: leave.entries, mineOpenedAt: leave.openedAt, others: [phase3]});
  assert.equal(later.errors.length, 1);
  assert.match(later.errors[0], /reuses the number, idx, when of 7260_viewer_access_version .* on #302, which reserved it first/);
  const earlier = migrationCollisions({base: main, mine: phase3.entries, mineOpenedAt: phase3.openedAt, others: [leave]});
  assert.deepEqual(earlier.errors, []);
  assert.equal(earlier.warnings.length, 1);
  assert.match(earlier.warnings[0], /on #305, opened later/);
});

test('a stacked PR carrying the same migration is not a collision', () => {
  const release6 = {ref: '#300', openedAt: '2026-11-25T00:10:00Z', entries: [...main, e(7240, 'access_visible_employment')]};
  const stacked = [...main, e(7240, 'access_visible_employment'), e(7280, 'leave_delegated_decision_set')];
  const result = migrationCollisions({base: main, mine: stacked, mineOpenedAt: '2026-11-25T02:00:00Z', others: [release6]});
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('a branch with no PR counts as earlier: checking before reserving always fails on a taken slot', () => {
  const branch = {ref: 'origin/claude/assignment-department-index', openedAt: null, entries: [...main, e(7230, 'assignment_index')]};
  const result = migrationCollisions({base: main, mine: [...main, e(7230, 'something_else')], mineOpenedAt: '2026-11-25T09:00:00Z', others: [branch]});
  assert.equal(result.errors.length, 1);
});

test('a slot only another branch\'s entries share with main is not counted against this branch', () => {
  assert.deepEqual(addedEntries(main, [...main, e(7220, 'movement')]).map(entry => entry.tag), ['7220_movement']);
});

test('suggests the next free slot above every journal seen', () => {
  const next = nextFreeSlot([main, [...main, e(7280, 'leave_delegated_decision_set')]]);
  assert.equal(next.number, 7290);
  assert.equal(next.when, e(7280, 'x').when + 10);
  assert.equal(next.after, '7280_leave_delegated_decision_set');
});
