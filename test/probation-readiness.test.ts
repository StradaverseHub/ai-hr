// I11: the "Some default probation messages are unavailable" warning ignores events a shared workflow covers.
import {describe,expect,it} from 'vitest';
import {probationReadinessWithSharedWorkflows} from '../lib/probation-readiness';

const status={companyName:'Fictional Company',canConfigure:true,missing:['kpi_assigned','review_due','letter_returned'] as const,summaryReady:false};
describe('probation readiness with shared workflows',()=>{
 it('keeps every warning when no shared workflow covers the events',()=>{
  expect(probationReadinessWithSharedWorkflows({...status,missing:[...status.missing]},new Set())).toEqual({...status,missing:['kpi_assigned','review_due','letter_returned']});
 });
 it('drops the events a Live or moved shared workflow covers, and the summary when the overdue summary is covered',()=>{
  expect(probationReadinessWithSharedWorkflows({...status,missing:[...status.missing]},new Set(['formIssued','letterSentBack','overdueSummary']))).toEqual({...status,missing:['review_due'],summaryReady:true});
  expect(probationReadinessWithSharedWorkflows({...status,missing:[...status.missing]},new Set(['formIssued','dueBeforeReview','letterSentBack','overdueSummary'])).missing).toEqual([]);
 });
});
