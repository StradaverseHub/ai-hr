/** Original M12 review found a job-type link with no usable destination. The AI Centre now
 * owns actual enablement forms. Verify both switch directions at the registry's real anchor,
 * retaining the original refusal of the empty delegated-jobs destination. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { enWithAiCentre } from '../helpers/ai-centre-messages';

const control=vi.hoisted(()=>({enabled:false}));
vi.mock('../../db/client',()=>({withTenant:async(_ctx:unknown,read:(tx:unknown)=>Promise<unknown>)=>read({})}));
vi.mock('../../core/ai-centre-control',()=>({aiCentreControlState:async()=>({stopped:false,generation:0,pending:0})}));
vi.mock('../../core/ai-centre-inventory',()=>({aiCentreFunctions:()=>[],aiCentreReadControls:async()=>new Map(),aiCentreJobTypes:()=>['daily_digest']}));
vi.mock('../../core/mandates/mandates',()=>({readMandateKeysTx:async()=>({enablement:{enabled:control.enabled,maxValidityDays:90,maxRunsPerDay:1}})}));
vi.mock('../../app/control-tower/agents/centre-control-actions',()=>({setAiCentreFunctionAction:vi.fn(),setAiCentreJobAction:vi.fn(),setAiCentreStopAction:vi.fn()}));

vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next-intl/server', () => ({ getTranslations: async (namespace: any) => createTranslator({ locale: 'en', messages: enWithAiCentre as never, namespace }) }));
vi.mock('../../app/control-tower/agents/actions', () => ({ setAiFeatureAction: vi.fn() }));

import { WorkerRegistry } from '../../app/control-tower/agents/worker-registry';
import { AiCentreControls } from '../../app/control-tower/agents/centre-controls';

afterEach(cleanup);
const wrap = (node: React.ReactNode) => render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never} timeZone="Asia/Kuala_Lumpur">{node}</NextIntlClientProvider>);
const digestRow = {
  id: 'daily_digest', label: 'Daily digest', family: 'preparer', trigger: { kind: 'schedule', detail: 'fixture' }, readScope: [], effect: 'prepare',
  authority: { kind: 'mandate', jobType: 'daily_digest' }, owners: [], switch: { on: false, owner: 'job_type', detail: 'off' },
  stopped: false, stopHonoured: true, stopPending: null, gate: { run: false, reasons: ['switched_off'] }, lastRunAt: null,
  metrics: { measured: false, acceptanceRate: null, reversalRate: null, decided: 0, reason: 'fixture' }, mandates: { active: 0, total: 0 },
} as never;

describe('Worker registry job-type switch', () => {
  it.each([false,true])('links the registry to a real job-type control (enabled: %s)',async enabled=>{
    control.enabled=enabled;
    const controls=await AiCentreControls({session:{tenantId:'fictional-control-tenant'}});
    wrap(<><WorkerRegistry rows={[digestRow]} summary={null} detail={null}/>{controls}</>);
    const link=screen.getByRole('link',{name:enWithAiCentre.aiCentre.registry.switchOwner.job_type});
    expect(link).toHaveAttribute('href','#ai-centre-jobs');
    expect(document.querySelector('#worker-daily_digest a[href="/assistant?view=jobs"]')).toBeNull();
    const destination=document.querySelector<HTMLElement>(link.getAttribute('href')!);
    expect(destination).not.toBeNull();
    const button=within(destination!).getByRole('button',{name:`${enabled?'Turn off':'Turn on'} · daily digest`});
    const form=button.closest('form');
    expect(form).not.toBeNull();
    expect(form!.querySelector('input[name="jobType"]')).toHaveValue('daily_digest');
    expect(form!.querySelector('input[name="enabled"]')).toHaveValue(String(!enabled));
    expect(button).toHaveAttribute('type','submit');
  });
});
