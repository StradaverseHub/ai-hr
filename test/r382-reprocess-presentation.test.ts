import fs from 'node:fs';
import path from 'node:path';
import React, { cloneElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import type { ReprocessEmployeeOutcome } from '../packs/payroll/service';
import { reprocessResultHrefs } from '../app/payroll/[batchId]/reprocess/result-links';
const state = vi.hoisted(() => ({locale:'en'}));
vi.mock('next-intl/server', () => ({
  getLocale: async () => state.locale,
  getTranslations: async (namespace:string) => createTranslator({locale:state.locale, namespace,
    messages:JSON.parse(fs.readFileSync(path.resolve(__dirname,`../messages/${state.locale}.json`),'utf8'))}),
}));
import { ReprocessOutcomePanel, ReprocessOutcomeStatus, ReprocessOutcomeRemarks } from '../app/payroll/[batchId]/reprocess/outcomes';

const run={companyId:'22222222-2222-4222-8222-222222222222',payPeriod:'2026-07',runType:'regular'};
const id='33333333-3333-4333-8333-333333333333';
const slipId='44444444-4444-4444-8444-444444444444';
const jobId='55555555-5555-4555-8555-555555555555';
const base:ReprocessEmployeeOutcome={employmentId:id,name:'Synthetic Employee',employeeCode:'SYNTH',status:'skipped',reasonCode:'NOTHING_PAYABLE',resultRetained:true,payslipId:slipId,versionBefore:2,versionAfter:2,historyId:null,at:'2026-07-31T10:00:00.000Z'};
const slips=[{id:slipId,employmentId:id,version:2}];
async function resolve(node:ReactNode):Promise<ReactNode> {
  if(Array.isArray(node)) return Promise.all(node.map(resolve));
  if(!isValidElement<{children?:ReactNode}>(node)) return node;
  if(node.type===ReprocessOutcomeStatus || node.type===ReprocessOutcomeRemarks)
    return resolve(await (node.type as (props:any)=>Promise<ReactNode>)(node.props));
  return cloneElement(node,{},await resolve(node.props.children));
}
async function html(outcomes:ReprocessEmployeeOutcome[],stopped=false) {
  return renderToStaticMarkup(await resolve(await ReprocessOutcomePanel({outcomes,history:[],slips,run,currency:'MYR',batchId:run.companyId,jobId,selected:outcomes.length,stopped,from:'/payroll?year=2026&m=7'})));
}

describe('r382 recorded processing outcome presentation',()=>{
  it('only the exact saved payslip version can be offered as this attempt’s result',()=>{
    const row={...base,id};
    expect(reprocessResultHrefs([row],slips,run).size).toBe(1);
    for(const wrong of [[],[{...slips[0],version:3}],[{...slips[0],id:jobId}],[{...slips[0],employmentId:jobId}]])
      expect(reprocessResultHrefs([row],wrong,run).size).toBe(0);
    const href=reprocessResultHrefs([row],slips,run,'/payroll?year=2026&m=7').get(id)!;
    const params=new URL(href,'https://example.test').searchParams;
    expect(params.get('employmentId')).toBe(id);expect(params.get('from')).toBe('/payroll?year=2026&m=7');
  });
  it.each(['en','ms','zh','ta','th','vi'])('renders a retained skip with full reason and no invented new net pay in %s',async locale=>{
    state.locale=locale;
    const output=await html([base]);
    const msg=JSON.parse(fs.readFileSync(path.resolve(__dirname,`../messages/${locale}.json`),'utf8')).payroll.batch;
    expect(output).toContain(msg.reprocessOutcomeStatus.skipped);
    expect(output).toContain(msg.reprocessNothingPayableFull.replaceAll('&','&amp;'));
    expect(output).toContain(msg.reprocessPreviousResultRetained.replaceAll('&','&amp;'));
    expect(output).toContain('<details');expect(output).toContain('SYNTH');expect(output).toContain('Synthetic Employee');
    expect(output).not.toContain('0.00');expect(output).not.toContain('MISSING_MESSAGE');
    expect(output).not.toContain('Remove employees');
    expect((output.match(/href="[^\"]*transaction-view/g)??[])).toHaveLength(1);
  });
  it('shows specific tax readiness and safe contextual repair, alongside successful and skipped employees',async()=>{
    state.locale='en';
    const tax={...base,employmentId:jobId,name:'Missing REP approval',status:'validation_failed' as const,reasonCode:'TAX_SCHEME_CONFIGURATION_INCOMPLETE' as const,validationCode:'missing_declaration',configuredTaxScheme:'rep' as const,resultRetained:false,payslipId:null,versionBefore:null,versionAfter:null};
    const success={...base,employmentId:run.companyId,name:'Successful Employee',status:'reprocessed' as const,reasonCode:null,resultRetained:false,versionBefore:1,versionAfter:2};
    const output=await html([success,base,tax]);
    expect(output).toContain('Reprocessed: 1');expect(output).toContain('Skipped: 1');expect(output).toContain('Configuration incomplete: 1');
    expect(output).toContain('REP');expect(output).toContain('no applicable approval');
    expect(output).toContain(`/payroll/${run.companyId}/tax-configuration/${jobId}`);
    expect(output).toContain(`job=${jobId}`);expect(output).toContain('from=%2Fpayroll');
    expect(output).not.toContain('Processing stopped before');
  });
  it('partial global failure keeps recorded successes visible without exposing an internal error',async()=>{
    state.locale='en';
    const output=await html([base],true);
    expect(output).toContain('Processing stopped before');expect(output).toContain('Previous payroll result retained');
    const src=fs.readFileSync(path.resolve(__dirname,'../app/payroll/[batchId]/reprocess/page.tsx'),'utf8');
    expect(src).not.toContain('thisJob.error');
    expect(src).not.toMatch(/r\.at\s*>=\s*thisJob\.createdAt/);
    expect(src).toContain("key={thisJob?.id ?? 'selection'}");
  });
});
