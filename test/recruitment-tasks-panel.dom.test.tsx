/**
 * Recruitment slice 9 (D-035): the Overview To do tab's per-job counts, rendered on their own (app/recruitment/todo-items.tsx
 * RecruitmentJobTodos, inside a Suspense boundary in tasks-panel.tsx). With counts it lists them; when the counts read
 * times out (the service answers 'unavailable') it says so in place with a link to refresh — no error page. The service is
 * mocked here; test/recruitment-tasks.test.ts forces the real timeout against Postgres.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import type { RecruitmentJobTodos as JobTodosResult, RecruitmentTodo } from '../packs/recruitment/service';

const state: { result: JobTodosResult } = { result: { status: 'ok', items: [] } };
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: en, namespace: namespace as 'recruitment.tasks' }),
}));
vi.mock('../packs/recruitment/service', () => ({
  recruitmentJobTodos: vi.fn(async () => state.result),
  countText: (n: number, cap = 100) => (n >= cap ? `${cap - 1}+` : String(n)),
  TODO_COUNT_CAP: 100,
}));
vi.mock('../app/recruitment/shared', () => ({
  klDateTime: (locale: string, iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(iso)),
}));
const { RecruitmentJobTodos, JobTodosLoading } = await import('../app/recruitment/todo-items');

const JOB = '11111111-1111-4111-8111-111111111111';
const item = (over: Partial<RecruitmentTodo>): RecruitmentTodo => ({
  kind: 'toScreen', id: JOB, companyId: JOB, jobId: JOB, title: 'Fictional data analyst', number: 'MJ000001', candidateName: null, candidateRemoved: false,
  count: 3, step: null, at: '2026-11-11T01:00:00.000Z', href: `/recruitment/candidates?job=${JOB}`, ...over,
});
const s = { tenantId: JOB, userId: JOB } as never;
afterEach(cleanup);

describe('the Overview per-job counts', () => {
  it('lists the job counts with their links when they load', async () => {
    state.result = { status: 'ok', items: [item({}), item({ kind: 'toSchedule', count: 1, href: `/recruitment/candidates?job=${JOB}&tab=x` })] };
    render((await RecruitmentJobTodos({ s, scopeIds: [] }))!);
    expect(screen.getByRole('heading', { name: en.recruitment.tasks.jobsTitle })).toBeTruthy();
    expect(screen.getByRole('link', { name: '3 new applications to screen' }).getAttribute('href')).toBe(`/recruitment/candidates?job=${JOB}`);
    expect(screen.getByRole('link', { name: '1 application to schedule for an interview' }).getAttribute('href')).toBe(`/recruitment/candidates?job=${JOB}&tab=x`);
    expect(screen.queryByText(en.recruitment.tasks.jobsUnavailable, { exact: false })).toBeNull();
  });

  it('says in place that the counts could not be loaded, with a refresh link, when the read times out', async () => {
    state.result = { status: 'unavailable' };
    render((await RecruitmentJobTodos({ s, scopeIds: [] }))!);
    expect(screen.getByRole('status').textContent).toContain(en.recruitment.tasks.jobsUnavailable);
    expect(screen.getByRole('link', { name: en.recruitment.tasks.jobsRefresh }).getAttribute('href')).toBe('/recruitment?tasks=todo#tasks');
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('renders nothing when there are no job counts, and a plain loading line while they stream', async () => {
    state.result = { status: 'ok', items: [] };
    expect(await RecruitmentJobTodos({ s, scopeIds: [] })).toBeNull();
    render(await JobTodosLoading());
    expect(screen.getByRole('status').textContent).toBe(en.recruitment.tasks.jobsLoading);
  });

  it('is streamed in its own Suspense boundary on the To do tab', () => {
    const panel = readFileSync(resolve(process.cwd(), 'app/recruitment/tasks-panel.tsx'), 'utf8');
    expect(panel).toContain('<Suspense fallback={<JobTodosLoading />}>');
    expect(panel).toContain('<RecruitmentJobTodos s={s} scopeIds={scopeIds} />');
  });
});
