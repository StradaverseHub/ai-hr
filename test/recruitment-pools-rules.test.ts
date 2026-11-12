/**
 * Recruitment slice 13 — the pure rules and the static shape of 4413 (no database). The database behaviour of cases 88–93 is in
 * test/recruitment-pools.test.ts and test/recruitment-blocked-list.test.ts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_REASON_MAX, POOL_NAME_MAX, POOL_SHARING, REVIEW_RESOLUTIONS, blockedIdentityMatch, identityOf, parsePoolKey, parseResolution, poolLabels,
  poolTree, reviewView, validateBlockedReason, validatePoolInput,
} from '../packs/recruitment/pool-model';
import { RECRUITMENT_ERROR_CODES, RecruitmentError } from '../packs/recruitment/model';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(`${root}${rel}`, 'utf8');
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const thrown = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return e instanceof RecruitmentError ? `${e.code}${e.detail ? `:${e.detail.join(',')}` : ''}` : String(e); } };

describe('pools', () => {
  it('validates a pool: name required (≤80), description ≤500, sharing, parent; a sub-pool takes no sharing of its own', () => {
    expect(validatePoolInput({ name: '  ' })).toEqual({ ok: false, code: 'missing_fields', fields: ['name'] });
    expect(validatePoolInput({ name: 'x'.repeat(POOL_NAME_MAX + 1) })).toEqual({ ok: false, code: 'invalid_input', fields: ['name'] });
    expect(validatePoolInput({ name: 'A', description: 'd'.repeat(501), sharing: 'everyone', parentId: 'nope', sharedUserIds: ['x'] }))
      .toEqual({ ok: false, code: 'invalid_input', fields: ['description', 'parentId', 'sharing', 'sharedUserIds'] });
    expect(validatePoolInput({ name: ' Fictional   graduates ', description: '' }))
      .toEqual({ ok: true, value: { name: 'Fictional graduates', description: null, parentId: null, sharing: 'all_recruiters', sharedUserIds: [] } });
    expect(validatePoolInput({ name: 'A', sharing: 'listed_users', sharedUserIds: [U1, U1, '', U2] }))
      .toEqual({ ok: true, value: { name: 'A', description: null, parentId: null, sharing: 'listed_users', sharedUserIds: [U1, U2] } });
    // All recruiters: the listed users are dropped; a sub-pool: neither sharing nor list.
    expect(validatePoolInput({ name: 'A', sharing: 'all_recruiters', sharedUserIds: [U1] })).toMatchObject({ value: { sharedUserIds: [] } });
    expect(validatePoolInput({ name: 'A', parentId: U1, sharing: 'listed_users', sharedUserIds: [U2] }))
      .toEqual({ ok: true, value: { name: 'A', description: null, parentId: U1, sharing: 'all_recruiters', sharedUserIds: [] } });
    expect(POOL_SHARING).toEqual(['all_recruiters', 'listed_users']);
  });

  it('builds the two-level tree by name and labels memberships "pool › sub-pool"', () => {
    const tree = poolTree([
      { id: 'b', parentId: null, name: 'beta' }, { id: 'a2', parentId: 'a', name: 'Zed' }, { id: 'a', parentId: null, name: 'Alpha' },
      { id: 'a1', parentId: 'a', name: 'apple' }, { id: 'orphan', parentId: 'gone', name: 'Orphan' },
    ]);
    expect(tree.map((t) => [t.id, t.children.map((c) => c.id)])).toEqual([['a', ['a1', 'a2']], ['b', []], ['orphan', []]]);
    expect(poolLabels([{ name: 'Sub', parentName: 'Top' }, { name: 'alpha', parentName: null }])).toEqual(['alpha', 'Top › Sub']);
    expect(parsePoolKey(undefined)).toEqual({ kind: 'public' });
    expect(parsePoolKey('blocked')).toEqual({ kind: 'blocked' });
    expect(parsePoolKey(U1)).toEqual({ kind: 'custom', id: U1 });
    expect(parsePoolKey('../etc')).toBeNull();
  });
});

describe('the blocked list', () => {
  const X = identityOf({ fullName: 'Fictional  Listed Person', email: 'Listed@Example.test', phone: '+60 12-345 6789', idNumber: 'ab-123456' });
  it('matches by the same ID number, the same name plus the same e-mail or mobile, or the same e-mail and mobile — never one item alone', () => {
    const cases: [string, Parameters<typeof identityOf>[0], boolean][] = [
      ['ID number only', { fullName: 'Someone Else', idNumber: 'AB123456' }, true],
      ['name + e-mail', { fullName: 'fictional listed   person', email: 'listed@example.TEST' }, true],
      ['name + mobile', { fullName: 'Fictional Listed Person', phone: '60123456789' }, true],
      ['name alone', { fullName: 'Fictional Listed Person' }, false],
      ['e-mail alone', { fullName: 'Other', email: 'listed@example.test' }, false],
      ['mobile alone', { fullName: 'Other', phone: '+60 12 345 6789' }, false],
      ['e-mail + mobile without the name', { fullName: 'Other', email: 'listed@example.test', phone: '60123456789' }, true],
      ['e-mail + a different mobile, other name', { fullName: 'Other', email: 'listed@example.test', phone: '60123456780' }, false],
      ['different ID number, nothing else', { fullName: 'Other', idNumber: 'AB123457' }, false],
    ];
    for (const [label, who, want] of cases) expect(blockedIdentityMatch(X, identityOf(who)), label).toBe(want);
    // An entry without values matches nothing by identity (only the listed candidate themself, by id, in the database).
    expect(blockedIdentityMatch(identityOf({}), identityOf({}))).toBe(false);
  });

  it('reasons are required and at most 500 characters; resolutions are the two named ones; views follow access', () => {
    expect(thrown(() => validateBlockedReason('   '))).toBe('reason_required');
    expect(thrown(() => validateBlockedReason('x'.repeat(BLOCKED_REASON_MAX + 1)))).toBe('invalid_input:reason');
    expect(validateBlockedReason('  Fictional reason ')).toBe('Fictional reason');
    expect(REVIEW_RESOLUTIONS).toEqual(['not_same_person', 'remove_from_list']);
    expect(parseResolution('not_same_person')).toBe('not_same_person');
    expect(thrown(() => parseResolution('approve'))).toBe('invalid_input:resolution');
    expect(reviewView({ admin: true, operate: true, read: true })).toBe('admin');
    expect(reviewView({ admin: false, operate: true, read: true })).toBe('operator');
    expect(reviewView({ admin: false, operate: false, read: true })).toBe('reader');
    expect(reviewView({ admin: false, operate: false, read: false })).toBeNull();
  });

  it('every new refusal has a sentence in every locale, translated', () => {
    const NEW_CODES = ['needs_review', 'already_blocked', 'blocked_entry_removed', 'mark_cleared', 'pool_depth', 'pool_has_subpools', 'blocked_entry_has_open_marks', 'own_entry_mark'];
    expect(RECRUITMENT_ERROR_CODES).toEqual(expect.arrayContaining(NEW_CODES));
    const en = JSON.parse(read('messages/en.json'));
    for (const locale of ['ms', 'ta', 'th', 'vi', 'zh']) {
      const m = JSON.parse(read(`messages/${locale}.json`));
      for (const c of NEW_CODES) {
        expect(m.recruitment.errors[c], `${locale} ${c}`).toBeTruthy();
        expect(m.recruitment.errors[c], `${locale} ${c}`).not.toBe(en.recruitment.errors[c]);
      }
      for (const key of ['nav.blocked', 'review.needsReview', 'blocked.add', 'settings.sharingOptions.listed_users']) {
        const get = (o: Record<string, unknown>) => key.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown>)?.[k], o);
        expect(get(m.recruitment.pools), `${locale} ${key}`).toBeTruthy();
        expect(get(m.recruitment.pools), `${locale} ${key}`).not.toBe(get(en.recruitment.pools));
      }
      expect(m.recruitment.settings.section.pools, locale).toBeTruthy();
    }
    // The hiring manager's sentence says nothing about the list.
    expect(en.recruitment.pools.review.readerNote).not.toMatch(/block/i);
    expect(en.recruitment.pools.review.needsReview).toBe("Needs an administrator's review");
  });
});

describe('migration 4413', () => {
  const m13 = read('db/migrations/4413_recruitment_talent_pools_blocked_list.sql');
  const m12 = read('db/migrations/4412_recruitment_background_checks.sql');
  const fn = (src: string, name: string) => {
    const start = src.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    return src.slice(start, src.indexOf('TO ai_hr_app;', start));
  };
  it('is journalled at idx 3813 / when 1793330004113 after 4412', () => {
    const journal = JSON.parse(read('db/migrations/meta/_journal.json')) as { entries: { idx: number; when: number; tag: string }[] };
    const i = journal.entries.findIndex((e) => e.tag === '4413_recruitment_talent_pools_blocked_list');
    expect(journal.entries[i]).toMatchObject({ idx: 3813, when: 1793330004113 });
    expect(journal.entries[i - 1]).toMatchObject({ tag: '4412_recruitment_background_checks', idx: 3812, when: 1793330004112 });
  });
  it('restates the removal and the company delete as 4412\'s bodies byte for byte plus added steps only', () => {
    for (const name of ['app.recruitment_destroy_candidate', 'app.recruitment_delete_company_setup']) {
      const before = fn(m12, name);
      const after = fn(m13, name);
      expect(after.length).toBeGreaterThan(before.length);
      // Every line of 4412's body is in 4413's, in the same order; nothing of it changed.
      const lines = after.split('\n');
      let at = 0;
      for (const line of before.split('\n')) {
        const found = lines.indexOf(line, at);
        expect(found, `${name}: ${line}`).toBeGreaterThanOrEqual(at);
        at = found + 1;
      }
      // What was added deletes or reports; it never updates an earlier table.
      const added = lines.filter((l) => !before.split('\n').includes(l)).join('\n');
      expect(added).toMatch(/recruitment_blocked_entry|recruitment_talent_pool/);
      expect(added).not.toMatch(/UPDATE public\./);
    }
  });
  it('adds the review-mark guard beside the earlier guards (none restated) and matches every channel at commit', () => {
    for (const earlier of ['recruitment_guard_application', 'recruitment_guard_offer', 'recruitment_guard_hire_handoff', 'recruitment_careers_submit',
      'recruitment_submit_referral', 'recruitment_guard_repeat_application']) {
      expect(m13).not.toMatch(new RegExp(`FUNCTION app\\.${earlier}\\(`));
    }
    expect(m13).toMatch(/CREATE CONSTRAINT TRIGGER recruitment_application_blocked_match AFTER INSERT ON public\.recruitment_application\s+DEFERRABLE INITIALLY DEFERRED/);
    expect(m13).toMatch(/CREATE TRIGGER recruitment_application_review_mark_guard BEFORE UPDATE OF current_stage_id, state ON public\.recruitment_application/);
    expect(m13).toMatch(/CREATE TRIGGER recruitment_offer_review_mark_guard BEFORE INSERT OR UPDATE ON public\.recruitment_offer/);
    expect(m13).toMatch(/CREATE TRIGGER recruitment_hire_handoff_review_mark_guard BEFORE INSERT ON public\.recruitment_hire_handoff/);
    // The matching never raises: the only RAISE statements are in the writers and guards, not in the matching functions.
    const match = m13.slice(m13.indexOf('CREATE FUNCTION app.recruitment_blocked_mark('), m13.indexOf('CREATE CONSTRAINT TRIGGER recruitment_application_blocked_match'));
    expect(match.length).toBeGreaterThan(2000);
    expect(match).toMatch(/FUNCTION app\.recruitment_blocked_match\(/);
    expect(match).not.toMatch(/RAISE/);
    // The removal takes the company's blocked-list lock and refuses by name while another candidate's hold depends on it; the
    // removal marker is read without assigning a transaction id.
    expect(fn(m13, 'app.recruitment_destroy_candidate')).toMatch(/pg_advisory_xact_lock\(app\.recruitment_blocked_lock_key[\s\S]*recruitment_blocked_entry_has_open_marks/);
    expect(m13).toMatch(/CREATE OR REPLACE FUNCTION app\.recruitment_destroying\(p_candidate uuid\)[\s\S]*?txid_current_if_assigned\(\)/);
    // No grant to PUBLIC anywhere in the migration.
    expect(m13).not.toMatch(/GRANT [^;]* TO PUBLIC/i);
  });
});
