import { describe, expect, it } from 'vitest';
import { anonymousFeedbackReport } from '../packs/performance/onehr/feedback-report';
import { assertOverallRemark } from '../packs/performance/onehr/journey-model';

const statements=[{id:'current',principle:'Ownership',text:'Takes responsibility',future:false},{id:'future',principle:'Ownership',text:'Develops others',future:true}];
describe('released anonymous feedback projection',()=>{
 it('reports per-statement agreement without future weighting or rater ordering',()=>{
  const submissions=[{answers:{current:'yes' as const,future:'no' as const},remark:'Zulu comment',comments:{Ownership:'Took responsibility for the handover.'},employmentId:'private-rater'},{answers:{current:'no' as const,future:'yes' as const},remark:'Alpha comment',comments:{Ownership:'Followed through on the work.'},employmentId:'other-rater'}];
  const report=anonymousFeedbackReport(statements,submissions);
  expect(report.statements.map(s=>s.agreementPct)).toEqual([50,50]);
  expect(report.remarks).toEqual(['Alpha comment','Zulu comment']);
  expect(report.comments).toEqual([{principle:'Ownership',text:'Followed through on the work.'},{principle:'Ownership',text:'Took responsibility for the handover.'}]);
  expect(report).toEqual(anonymousFeedbackReport(statements,[...submissions].reverse()));
  expect(JSON.stringify(report)).not.toMatch(/private-rater|other-rater|employmentId|relationship|score|count/);
 });
 it('keeps absence of submitted answers distinct from zero agreement',()=>{
  expect(anonymousFeedbackReport(statements,[]).statements.map(s=>s.agreementPct)).toEqual([null,null]);
  expect(anonymousFeedbackReport(statements,[{answers:{current:'no',future:'no'},remark:''}]).statements.map(s=>s.agreementPct)).toEqual([0,0]);
 });
 it('rounds at source boundaries and aggregates principles before rounding',()=>{
  const submissions=Array.from({length:8},(_,i)=>({answers:{current:i===0?'yes' as const:'no' as const,future:i<7?'yes' as const:'no' as const},remark:''}));
  const report=anonymousFeedbackReport(statements,submissions);
  expect(report.statements.map(s=>s.agreementPct)).toEqual([12,88]);
  expect(report.principles).toEqual([{principle:'Ownership',agreementPct:50}]);
 });
 it('enforces the source hard ceiling of 220 words and only requires remarks at the applicable step',()=>{
  expect(()=>assertOverallRemark('')).not.toThrow();
  expect(()=>assertOverallRemark('',true)).toThrow();
  expect(()=>assertOverallRemark(Array(220).fill('word').join(' '),true)).not.toThrow();
  expect(()=>assertOverallRemark(Array(221).fill('word').join(' '))).toThrow();
 });
});
