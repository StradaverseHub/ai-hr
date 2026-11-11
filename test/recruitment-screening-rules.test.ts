/**
 * Recruitment slice 11 pure rules (no database): the send and answer inputs, the derived assignment status and its counts,
 * the to-do and update vocabulary, and the words every locale needs. The database behaviour (cases 75–80) is
 * test/recruitment-screening.test.ts. Every value is fictional.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RECRUITMENT_TASK_KINDS } from '../lib/assigned-work';
import {
  ASSIGNMENT_STATUSES, PERSONAL_TODO_KINDS, SCREENING_CLOSE_REASONS, SCREENING_LIST_LIMIT, RECRUITMENT_ERROR_CODES, RecruitmentError, SCREENING_COMMENT_MAX, SCREENING_NOTE_MAX, SCREENING_RESULTS,
  SCREENING_SEND_MAX, TODO_KINDS, UPDATE_KINDS, assignmentStatus, closesRequest, parseAssignmentFilter, requestState, statusCounts, todoHref, todoToPackTask,
  validateAnswerInput, validateSendInput, type RecruitmentTodo,
} from '../packs/recruitment/service';

const root = fileURLToPath(new URL('..', import.meta.url));
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const code = (fn: () => unknown) => {
  try { fn(); return 'ok'; } catch (e) { return e instanceof RecruitmentError ? e.code : String(e); }
};

describe('send input', () => {
  it('needs one to SCREENING_SEND_MAX applications as ids; reviewers default to everyone; note is optional and bounded', () => {
    expect(code(() => validateSendInput({}))).toBe('missing_fields');
    expect(code(() => validateSendInput({ applicationIds: ['not-a-uuid'] }))).toBe('invalid_input');
    expect(code(() => validateSendInput({ applicationIds: Array.from({ length: SCREENING_SEND_MAX + 1 }, (_, i) => U(i + 1)) }))).toBe('invalid_input');
    expect(validateSendInput({ applicationIds: Array.from({ length: SCREENING_SEND_MAX }, (_, i) => U(i + 1)) }).applicationIds).toHaveLength(100);
    // Duplicates collapse; a single value is a list of one.
    expect(validateSendInput({ applicationIds: [U(1), U(1)], reviewerUserIds: U(9) })).toEqual({ applicationIds: [U(1)], reviewerUserIds: [U(9)], note: null, move: false });
    expect(validateSendInput({ applicationIds: [U(1)], reviewerUserIds: [] }).reviewerUserIds).toBeNull();
    expect(code(() => validateSendInput({ applicationIds: [U(1)], reviewerUserIds: ['x'] }))).toBe('invalid_input');
    expect(validateSendInput({ applicationIds: [U(1)], note: '   ' }).note).toBeNull();
    expect(validateSendInput({ applicationIds: [U(1)], note: '  Fictional note  ', move: true })).toMatchObject({ note: 'Fictional note', move: true });
    expect(validateSendInput({ applicationIds: [U(1)], note: 'n'.repeat(SCREENING_NOTE_MAX) }).note).toHaveLength(SCREENING_NOTE_MAX);
    expect(code(() => validateSendInput({ applicationIds: [U(1)], note: 'n'.repeat(SCREENING_NOTE_MAX + 1) }))).toBe('invalid_input');
    // Only the boolean true moves (a form's "on" is translated by the action).
    expect(validateSendInput({ applicationIds: [U(1)], move: 'on' }).move).toBe(false);
  });
});

describe('answer input (the one company form, D-040)', () => {
  it('requires Advance, Reject or Pending; the comment is optional and bounded', () => {
    expect([...SCREENING_RESULTS]).toEqual(['advance', 'reject', 'pending']);
    expect(code(() => validateAnswerInput({}))).toBe('missing_fields');
    expect(code(() => validateAnswerInput({ result: 'maybe' }))).toBe('invalid_input');
    expect(validateAnswerInput({ result: 'pending', comment: '' })).toEqual({ result: 'pending', comment: null });
    expect(validateAnswerInput({ result: 'advance', comment: ' Fictional strengths ' })).toEqual({ result: 'advance', comment: 'Fictional strengths' });
    expect(code(() => validateAnswerInput({ result: 'reject', comment: 'c'.repeat(SCREENING_COMMENT_MAX + 1) }))).toBe('invalid_input');
    // Characters, not UTF-16 units: 2,000 emoji are allowed.
    expect(validateAnswerInput({ result: 'reject', comment: '🙂'.repeat(SCREENING_COMMENT_MAX) }).comment).toBe('🙂'.repeat(SCREENING_COMMENT_MAX));
    expect(closesRequest('advance')).toBe(true);
    expect(closesRequest('reject')).toBe(true);
    expect(closesRequest('pending')).toBe(false);
    expect(requestState(null)).toBe('open');
    expect(requestState('withdrawn')).toBe('withdrawn');
    expect([...SCREENING_CLOSE_REASONS]).toEqual(['answered', 'withdrawn', 'application_closed', 'reviewer_removed']);
    expect(SCREENING_LIST_LIMIT).toBe(200);
  });
});

describe('assignment status (EV-052, D-042)', () => {
  const open = { closedAt: null };
  const closed = { closedAt: '2026-11-11T02:00:00.000Z' };
  const a = (id: number, result: 'advance' | 'reject' | 'pending', at: string) => ({ id: U(id), result, answeredAt: `2026-11-11T0${at}:00:00.000000Z` });
  it('an open request is Awaiting; otherwise the most recent final answer decides; otherwise Not assigned', () => {
    expect(assignmentStatus([], [])).toBe('not_assigned');
    expect(assignmentStatus([open], [])).toBe('awaiting');
    expect(assignmentStatus([open], [a(1, 'pending', '1')])).toBe('awaiting');
    expect(assignmentStatus([closed], [a(1, 'advance', '1')])).toBe('positive');
    expect(assignmentStatus([closed], [a(1, 'reject', '1')])).toBe('negative');
    // Several reviewers: the latest FINAL answer, whoever gave it.
    expect(assignmentStatus([closed, closed], [a(1, 'advance', '1'), a(2, 'reject', '2')])).toBe('negative');
    expect(assignmentStatus([closed, closed], [a(1, 'reject', '1'), a(2, 'advance', '2')])).toBe('positive');
    // Any open request wins over a final answer (a final answer plus one reviewer still to answer; reassigned after a final).
    expect(assignmentStatus([closed, open], [a(1, 'advance', '1')])).toBe('awaiting');
    expect(assignmentStatus([closed, open], [a(1, 'reject', '1'), a(2, 'pending', '2')])).toBe('awaiting');
    // A later Pending on a request that then closed without a final answer does not override an earlier final answer.
    expect(assignmentStatus([closed, closed], [a(1, 'advance', '1'), a(2, 'pending', '3')])).toBe('positive');
    // Input order does not matter; equal times fall back to the larger id.
    expect(assignmentStatus([closed, closed], [a(2, 'reject', '2'), a(1, 'advance', '1')])).toBe('negative');
    expect(assignmentStatus([closed, closed], [a(5, 'advance', '1'), a(4, 'reject', '1')])).toBe('positive');
    // Withdrawn, Pending then withdrawn, or closed by itself without a final answer: Not assigned.
    expect(assignmentStatus([closed, closed], [])).toBe('not_assigned');
    expect(assignmentStatus([closed], [a(1, 'pending', '1')])).toBe('not_assigned');
  });
  it('counts every status, zero when none, and parses the board filter', () => {
    expect(statusCounts(['awaiting', 'positive', 'awaiting'])).toEqual({ not_assigned: 0, awaiting: 2, positive: 1, negative: 0 });
    expect(Object.keys(statusCounts([]))).toEqual([...ASSIGNMENT_STATUSES]);
    for (const s of ASSIGNMENT_STATUSES) expect(parseAssignmentFilter(s)).toBe(s);
    expect(parseAssignmentFilter('everything')).toBeNull();
    expect(parseAssignmentFilter(undefined)).toBeNull();
  });
});

describe('to-do and update vocabulary', () => {
  it('a screening request is a personal to-do and a bell task; an answer is an Applications update', () => {
    expect(TODO_KINDS).toContain('screening');
    expect(PERSONAL_TODO_KINDS).toContain('screening');
    expect(RECRUITMENT_TASK_KINDS).toContain('recruitmentScreening');
    expect(UPDATE_KINDS.applications).toContain('screeningFeedback');
    expect(todoHref('screening', { id: U(7) })).toBe(`/recruitment/screening#request-${U(7)}`);
    const item: RecruitmentTodo = {
      kind: 'screening', id: U(7), companyId: U(1), jobId: U(2), title: 'Fictional analyst', number: 'MJ0001', candidateName: 'Fictional Person',
      candidateRemoved: false, count: null, step: null, at: '2026-11-11T01:00:00.000Z', href: '/x',
    };
    expect(todoToPackTask(item)).toEqual({ id: `screening:${U(7)}`, kind: 'recruitmentScreening', subjectName: 'Fictional Person · Fictional analyst', createdAt: item.at, linkPath: '/x' });
    expect(todoToPackTask({ ...item, candidateRemoved: true, candidateName: null })?.subjectName).toBe('Fictional analyst');
  });
});

describe('words in every locale', () => {
  const read = (locale: string) => JSON.parse(readFileSync(join(root, `messages/${locale}.json`), 'utf8')) as Record<string, Record<string, Record<string, unknown>>>;
  const get = (obj: unknown, path: string) => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
  const KEYS = [
    'recruitment.tabs.screening', 'recruitment.tasks.todo.screening', 'recruitment.tasks.todo.screeningFor', 'recruitment.tasks.update.screeningFeedback',
    'notifications.task.recruitmentScreening', 'notifications.taskAction.recruitmentScreening', 'recruitment.screening.tab', 'recruitment.screening.send',
    'recruitment.screening.sendFeedback', 'recruitment.screening.alsoMove', 'recruitment.screening.otherAnswers', 'recruitment.screening.toScreenEmpty',
    ...SCREENING_RESULTS.map((r) => `recruitment.screening.result.${r}`), ...SCREENING_RESULTS.map((r) => `recruitment.screening.resultHint.${r}`),
    ...ASSIGNMENT_STATUSES.map((s) => `recruitment.screening.status.${s}`), ...['open', 'answered', 'withdrawn', 'application_closed', 'reviewer_removed'].map((s) => `recruitment.screening.state.${s}`),
    'recruitment.screening.closedAt', 'recruitment.screening.reviewersUnavailable', 'recruitment.screening.countWindow',
    ...['not_hiring_manager', 'no_hiring_manager', 'screening_closed', 'not_your_request', 'mixed_jobs'].map((c) => `recruitment.errors.${c}`),
  ];
  it('every slice 11 key exists in all six locales, translated, with the same placeholders; every error code has words', () => {
    const en = read('en');
    for (const key of KEYS) expect(typeof get(en, key), key).toBe('string');
    for (const c of RECRUITMENT_ERROR_CODES) expect(typeof get(en, `recruitment.errors.${c}`), c).toBe('string');
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const locale of ['ms', 'ta', 'th', 'vi', 'zh']) {
      const m = read(locale);
      for (const key of KEYS) {
        const value = get(m, key);
        expect(typeof value, `${locale} ${key}`).toBe('string');
        expect(placeholders(value as string), `${locale} ${key}`).toEqual(placeholders(get(en, key) as string));
      }
      expect(get(m, 'recruitment.screening.send'), locale).not.toBe(get(en, 'recruitment.screening.send'));
      expect(get(m, 'notifications.taskAction.recruitmentScreening'), locale).not.toBe(get(en, 'notifications.taskAction.recruitmentScreening'));
    }
  });
  it('uses the business words, not the reference product\'s', () => {
    const text = JSON.stringify(get(read('en'), 'recruitment.screening'));
    expect(text).not.toMatch(/moka|evaluation form|assign to hiring manager/i);
  });
});
