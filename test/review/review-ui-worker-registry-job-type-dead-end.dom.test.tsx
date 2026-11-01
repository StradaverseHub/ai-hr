/** REVIEW (independent UI review) — drafted as test/review/worker-registry-job-type-dead-end.dom.test.tsx.
 *
 * Group administrator, AI centre › Workers › Worker registry. Two registered workers (daily_digest and
 * team_absence_weekly_summary, core/agent-registry/workers.ts:138,142) have switch owner 'job_type'. Their
 * row says "Change in delegated jobs" and links to /assistant?view=jobs (worker-registry.tsx:30). That view
 * (components/ai-centre/delegated-jobs.tsx) reads nothing and has no control: it says delegated jobs are not
 * available yet. core/mandates/mandates.ts exports setJobTypeEnablement/grantMandate but nothing under app/
 * or components/ calls them. So the administrator follows "Change ..." to a page where nothing can be changed.
 * Expected: until a job-type control exists, the row states that the job type cannot be switched on yet
 * (no link), or the link goes to a page that has the control.
 * FAILED on 7d57fc6a4 and on cdfcf53f (run 41353460111); passes on claude/teras-fix-ui. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { enWithAiCentre } from '../helpers/ai-centre-messages';

vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next-intl/server', () => ({ getTranslations: async (namespace: any) => createTranslator({ locale: 'en', messages: enWithAiCentre as never, namespace }) }));
vi.mock('../../app/control-tower/agents/actions', () => ({ setAiFeatureAction: vi.fn() }));

import { WorkerRegistry } from '../../app/control-tower/agents/worker-registry';
import { AiCentreDelegatedJobs } from '../../components/ai-centre/delegated-jobs';

afterEach(cleanup);
const wrap = (node: React.ReactNode) => render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never} timeZone="Asia/Kuala_Lumpur">{node}</NextIntlClientProvider>);
const digestRow = {
  id: 'daily_digest', label: 'Daily digest', family: 'preparer', trigger: { kind: 'schedule', detail: 'fixture' }, readScope: [], effect: 'prepare',
  authority: { kind: 'mandate', jobType: 'daily_digest' }, owners: [], switch: { on: false, owner: 'job_type', detail: 'off' },
  stopped: false, stopHonoured: true, stopPending: null, gate: { run: false, reasons: ['switched_off'] }, lastRunAt: null,
  metrics: { measured: false, acceptanceRate: null, reversalRate: null, decided: 0, reason: 'fixture' }, mandates: { active: 0, total: 0 },
} as never;

describe('Worker registry job-type switch', () => {
  it('fixed M12: "Change in delegated jobs" does not lead to a view with no control', async () => {
    const jobs = wrap(await AiCentreDelegatedJobs());
    const jobsHasControl = jobs.container.querySelector('form, button, input, select') !== null;
    jobs.unmount();

    wrap(<WorkerRegistry rows={[digestRow]} summary={null} detail={null} />);
    const link = screen.queryByRole('link', { name: enWithAiCentre.aiCentre.registry.switchOwner.job_type });
    if (link?.getAttribute('href') === '/assistant?view=jobs') expect(jobsHasControl, 'the registry sends the administrator to Delegated jobs, which has no control').toBe(true);
    // Fixed by saying so instead of linking (no job-type control exists yet): no link to Delegated jobs at all,
    // and the row states that the job type cannot be switched on from a screen yet.
    expect(document.querySelector('#worker-daily_digest a[href="/assistant?view=jobs"]')).toBeNull();
    expect(document.querySelector('#worker-daily_digest [data-switch-unavailable]')).toHaveTextContent(enWithAiCentre.aiCentre.registry.switchOwner.job_type);
  });
});
