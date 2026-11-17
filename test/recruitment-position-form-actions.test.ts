/**
 * Slice 15 review — the two form actions RETURN a refusal (no redirect, nothing typed in a URL) and keep the chosen company; only a
 * successful save redirects. No database: the session, the service calls, Next's redirect/revalidate and the translations are
 * replaced; the rest of app/recruitment/actions.ts runs as written. The browser side (values staying in the fields) is
 * test/recruitment-position-forms.dom.test.tsx.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redirect = vi.fn((url: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { url }); });
const createJob = vi.fn();
const savePositionTemplate = vi.fn();
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => `text:${key}` }));
vi.mock('@/lib/session', () => ({ getSession: async () => ({ tenantId: 't', userId: 'u' }) }));
vi.mock('@/packs/recruitment/service', async () => ({
  ...(await import('../packs/recruitment/model')),
  ...(await import('../packs/recruitment/custom-field-model')),
  createJob: (...args: unknown[]) => createJob(...args),
  savePositionTemplate: (...args: unknown[]) => savePositionTemplate(...args),
}));

const { createJobFormAction, savePositionTemplateFormAction } = await import('../app/recruitment/actions');
const { RecruitmentError } = await import('../packs/recruitment/model');

const COMPANY_B = '00000000-0000-4000-8000-00000000000b';
const FORM1 = '00000000-0000-4000-8000-000000000001';
const CF = '00000000-0000-4000-8000-000000000002';
const form = (entries: [string, string][]) => { const f = new FormData(); for (const [k, v] of entries) f.append(k, v); return f; };

beforeEach(() => { redirect.mockClear(); createJob.mockReset(); savePositionTemplate.mockReset(); });

describe('createJobFormAction', () => {
  it('a refusal returns the code, its sentence, the refused fields and every typed value — the company included — without redirecting', async () => {
    createJob.mockRejectedValueOnce(new RecruitmentError('invalid_input', ['interviewPlan']));
    const f = form([['companyId', COMPANY_B], ['title', 'Fictional analyst'], [`cf.${CF}`, 'Rotating'], ['cf.present', '1'], ['ip.present', '1'],
      ['interviewPlanFormIds', ''], ['interviewPlanFormIds', FORM1]]);
    const state = await createJobFormAction({ status: 'idle' }, f);
    expect(redirect).not.toHaveBeenCalled();
    expect(state).toEqual({
      status: 'refused', problem: 'invalid_input', errorText: 'text:invalid_input', fields: ['interviewPlan'], nonce: 1,
      values: { companyId: [COMPANY_B], title: ['Fictional analyst'], [`cf.${CF}`]: ['Rotating'], 'cf.present': ['1'], 'ip.present': ['1'], interviewPlanFormIds: ['', FORM1] },
    });
    // The service was asked for THIS company, with the plan and custom values as typed.
    expect(createJob.mock.calls[0][1]).toMatchObject({ companyId: COMPANY_B, interviewPlanFormIds: ['', FORM1], custom: { [CF]: ['Rotating'] } });
    // A second refusal counts on (so the form re-applies values even when they are unchanged).
    createJob.mockRejectedValueOnce(new RecruitmentError('missing_fields', ['title']));
    expect((await createJobFormAction(state, f)).nonce).toBe(2);
  });

  it('an unexpected error is a refusal too ("unexpected"), and a success redirects to the new position', async () => {
    createJob.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    expect(await createJobFormAction({ status: 'idle' }, form([['companyId', COMPANY_B]]))).toMatchObject({ status: 'refused', problem: 'unexpected', fields: [] });
    createJob.mockResolvedValueOnce({ id: 'job-1', jobNumber: 'MJ000001' });
    await expect(createJobFormAction({ status: 'idle' }, form([['companyId', COMPANY_B]]))).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/recruitment/positions/job-1?notice=created');
  });
});

describe('savePositionTemplateFormAction', () => {
  it('a refusal returns the typed values without redirecting; a success goes back to the company\'s template list', async () => {
    savePositionTemplate.mockRejectedValueOnce(new RecruitmentError('name_taken'));
    const f = form([['companyId', COMPANY_B], ['name', 'Fictional template'], ['title', 'Fictional job'], ['interviewPlanFormIds', FORM1]]);
    expect(await savePositionTemplateFormAction({ status: 'idle' }, f)).toMatchObject({
      status: 'refused', problem: 'name_taken', fields: [], values: { companyId: [COMPANY_B], name: ['Fictional template'], title: ['Fictional job'] },
    });
    expect(redirect).not.toHaveBeenCalled();
    savePositionTemplate.mockResolvedValueOnce({ id: 'tpl-1' });
    await expect(savePositionTemplateFormAction({ status: 'idle' }, f)).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith(`/recruitment/settings?company=${COMPANY_B}&section=templates&notice=saved`);
  });
});
