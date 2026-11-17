/**
 * Recruitment slice 9 pure rules (no database): the Tasks panel's tabs, paging and badges, the links of to-dos and
 * updates, and the bell projection (packs/recruitment/tasks-model.ts), plus the labels every kind needs in all six
 * locales. test/recruitment-tasks.test.ts proves the live reads against Postgres (cases 59–64).
 */
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';
import { PACK_TASK_KINDS, RECRUITMENT_TASK_KINDS } from '../lib/assigned-work';
import {
  TASK_CATEGORIES, TASK_TABS, TODO_COUNT_CAP, TODO_KINDS, PERSONAL_TODO_KINDS, JOB_TODO_KINDS, UNREAD_CAP, UPDATE_KINDS, UPDATES_MAX_PAGE, UPDATES_WINDOW_DAYS, byNewest, countText,
  isTaskCategory, parseTaskTab, parseUpdatesPage, readCategories, todoHref, todoToPackTask, updateHref, updatesSince, type RecruitmentTodo,
  UPDATES_PAGE_SIZE, decodeUpdatesCursor, encodeUpdatesCursor, updatesHasMore,
} from '../packs/recruitment/tasks-model';

const JOB = '11111111-1111-4111-8111-111111111111';
const STAGE = '22222222-2222-4222-8222-222222222222';
const todo = (over: Partial<RecruitmentTodo> = {}): RecruitmentTodo => ({
  kind: 'feedback', id: JOB, companyId: STAGE, jobId: JOB, title: 'Fictional data analyst', number: 'MJ000001', candidateName: 'Fictional Candidate',
  candidateRemoved: false, count: null, step: null, at: '2026-11-11T01:00:00.000Z', href: '/recruitment', ...over,
});

describe('tabs, categories and paging', () => {
  it('has To do first, then one tab per update category; anything else is To do', () => {
    expect(TASK_TABS).toEqual(['todo', 'requisitions', 'offers', 'interviews', 'applications']);
    expect(TASK_CATEGORIES).toEqual(['requisitions', 'offers', 'interviews', 'applications']);
    expect(parseTaskTab('offers')).toBe('offers');
    for (const v of [undefined, '', 'Offers', 'all', 42, ['offers']]) expect(parseTaskTab(v)).toBe('todo');
    expect(isTaskCategory('interviews')).toBe(true);
    expect(isTaskCategory('todo')).toBe(false);
    expect(isTaskCategory('all')).toBe(false);
  });
  it('reads the page as a whole number from 1, capped', () => {
    expect(parseUpdatesPage('3')).toBe(3);
    expect(parseUpdatesPage(2)).toBe(2);
    for (const v of [undefined, '', '0', '-1', '1.5', 'x', '00000', 1.5]) expect(parseUpdatesPage(v)).toBe(1);
    expect(parseUpdatesPage('9999')).toBe(UPDATES_MAX_PAGE);
  });
  it('offers "Older" only with more rows than a page and before the last allowed page', () => {
    expect(updatesHasMore(1, UPDATES_PAGE_SIZE + 1)).toBe(true);
    expect(updatesHasMore(1, UPDATES_PAGE_SIZE)).toBe(false);
    expect(updatesHasMore(UPDATES_MAX_PAGE - 1, UPDATES_PAGE_SIZE + 1)).toBe(true);
    expect(updatesHasMore(UPDATES_MAX_PAGE, UPDATES_PAGE_SIZE + 1)).toBe(false);
  });
  it('round-trips the keyset cursor and refuses anything else', () => {
    const at = '2026-11-11T01:02:03.456Z';
    for (const id of [JOB, `${JOB}:careers`, `${JOB}:decision`]) expect(decodeUpdatesCursor(encodeUpdatesCursor(at, id))).toEqual({ at, id });
    for (const v of [undefined, '', 'x', `${at}`, `${at}_${JOB}_x`, `2026-11-11_${JOB}`, `${at}_${JOB}:other`, `${at}_not-a-uuid`, 'a'.repeat(200), 42]) {
      expect(decodeUpdatesCursor(v)).toBeNull();
    }
  });
  it('marks one category or every category', () => {
    expect(readCategories('offers')).toEqual(['offers']);
    expect(readCategories('all')).toEqual([...TASK_CATEGORIES]);
  });
  it('starts the window exactly 90 days before now and caps badge text', () => {
    expect(UPDATES_WINDOW_DAYS).toBe(90);
    expect(updatesSince(new Date('2026-11-11T00:00:00Z')).toISOString()).toBe('2026-08-13T00:00:00.000Z');
    expect(countText(0)).toBe('0');
    expect(countText(UNREAD_CAP - 1)).toBe('99');
    expect(countText(UNREAD_CAP)).toBe('99+');
    expect(countText(TODO_COUNT_CAP, TODO_COUNT_CAP)).toBe('99+');
  });
  it('sorts newest first, then by kind and id', () => {
    const items = [{ at: '2026-11-10T00:00:00Z', kind: 'b', id: '1' }, { at: '2026-11-11T00:00:00Z', kind: 'b', id: '2' }, { at: '2026-11-10T00:00:00Z', kind: 'a', id: '3' }];
    expect([...items].sort(byNewest).map((i) => i.id)).toEqual(['2', '3', '1']);
  });
});

describe('links', () => {
  it('sends approvals to the Approvals page, feedback to its form and counts to the job\'s Candidates tab', () => {
    expect(todoHref('requisitionApproval', { id: JOB })).toBe('/recruitment/approvals');
    expect(todoHref('offerApproval', { id: JOB })).toBe('/recruitment/approvals');
    expect(todoHref('feedback', { id: JOB })).toBe(`/recruitment/interviews/${JOB}/feedback`);
    expect(todoHref('toSchedule', { id: JOB, jobId: JOB, stageId: STAGE })).toBe(`/recruitment/candidates?job=${JOB}&tab=${STAGE}`);
    expect(todoHref('toScreen', { id: JOB, jobId: JOB, stageId: null })).toBe(`/recruitment/candidates?job=${JOB}`);
  });
  it('opens a requisition update on the requisition and every other update on the application', () => {
    expect(updateHref('requisitionDenied', { requisitionId: JOB })).toBe(`/recruitment/requisitions/${JOB}`);
    for (const kind of ['offerApproved', 'offerDeclined', 'feedbackSubmitted', 'careersApplication', 'referral'] as const) {
      expect(updateHref(kind, { applicationId: STAGE })).toBe(`/recruitment/applications/${STAGE}`);
    }
  });
});

describe('the bell projection', () => {
  it('maps every personal to-do kind to its own recruitment bell kind, with only the five task fields', () => {
    expect([...PERSONAL_TODO_KINDS, ...JOB_TODO_KINDS].sort()).toEqual([...TODO_KINDS].sort());
    const kinds = PERSONAL_TODO_KINDS.map((kind) => todoToPackTask(todo({ kind }))!.kind);
    expect(kinds).toEqual([...RECRUITMENT_TASK_KINDS]);
    expect(new Set(kinds).size).toBe(PERSONAL_TODO_KINDS.length);
    for (const k of RECRUITMENT_TASK_KINDS) expect(PACK_TASK_KINDS).toContain(k);
    const item = todoToPackTask(todo({ href: '/recruitment/interviews/x/feedback' }));
    expect(item).toEqual({ id: `feedback:${JOB}`, kind: 'recruitmentFeedback', subjectName: 'Fictional Candidate · Fictional data analyst', createdAt: '2026-11-11T01:00:00.000Z', linkPath: '/recruitment/interviews/x/feedback' });
  });
  it('gives the bell no per-job count (D-035)', () => {
    for (const kind of JOB_TODO_KINDS) expect(todoToPackTask(todo({ kind, candidateName: null, count: 3 }))).toBeNull();
    // Slice 11's recruitmentScreening is one hiring manager's own screening request (a personal to-do), not a per-job count.
    expect(PACK_TASK_KINDS.filter((k) => /schedule|screen/i.test(k))).toEqual(['recruitmentScreening']);
  });
  it('names a removed or unreadable candidate by the job only', () => {
    expect(todoToPackTask(todo({ candidateRemoved: true, candidateName: null }))!.subjectName).toBe('Fictional data analyst');
    expect(todoToPackTask(todo({ kind: 'offerApproval', candidateName: null, title: null, number: null }))!.subjectName).toBeNull();
    expect(todoToPackTask(todo({ kind: 'requisitionApproval', candidateName: null, title: 'Fictional analysts', number: 'HC000001' }))!.subjectName).toBe('Fictional analysts');
  });
});

describe('labels in all six locales', () => {
  const locales = { en, ms, ta, th, vi, zh } as Record<string, { notifications: { task: Record<string, string> }; recruitment: { tasks: Record<string, unknown> } }>;
  it('has a bell label for every recruitment kind and a panel label for every tab, to-do and update kind', () => {
    for (const [locale, m] of Object.entries(locales)) {
      for (const kind of RECRUITMENT_TASK_KINDS) expect(m.notifications.task[kind], `${locale} ${kind}`).toBeTruthy();
      const tasks = m.recruitment.tasks as { tabs: Record<string, string>; todo: Record<string, string>; update: Record<string, string> };
      for (const tab of TASK_TABS) expect(tasks.tabs[tab], `${locale} tab ${tab}`).toBeTruthy();
      for (const kind of TODO_KINDS) expect(tasks.todo[kind], `${locale} todo ${kind}`).toBeTruthy();
      for (const kind of Object.values(UPDATE_KINDS).flat()) expect(tasks.update[kind], `${locale} update ${kind}`).toBeTruthy();
    }
    // Real translations: no locale repeats the English panel title or bell labels.
    for (const [locale, m] of Object.entries(locales)) {
      if (locale === 'en') continue;
      for (const kind of RECRUITMENT_TASK_KINDS) expect(m.notifications.task[kind], `${locale} ${kind}`).not.toBe(en.notifications.task[kind as keyof typeof en.notifications.task]);
    }
  });
});
