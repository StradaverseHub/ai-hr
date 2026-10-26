/** @vitest-environment jsdom */
/** Authored UNRUN. Presentation/POST boundaries only, not native authority or promotion proof. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
vi.mock('next-intl/server',()=>({getTranslations:vi.fn(async(namespace:string)=>(key:string,values?:Record<string,unknown>)=>namespace+'.'+key+(values?' '+JSON.stringify(values):''))}));
vi.mock('../app/assistant/specialist-review-actions',()=>({createSpecialistCandidateAction:vi.fn(),evaluateSpecialistCandidateAction:vi.fn(),promoteSpecialistCandidateAction:vi.fn(),rollbackSpecialistCandidateAction:vi.fn(),runSpecialistJobAction:vi.fn()}));
import {ModuleSpecialistReview,SpecialistJobComposer} from '../components/assistant/module-specialist-review';
afterEach(cleanup);
function view(){return{modules:[{module:'leave' as const,nextVersion:3}],candidates:[
 {id:'own',module:'leave' as const,version:1,own:true,evaluations:2,passingEvaluators:2,incompleteEvaluators:0},
 {id:'missing-domain',module:'leave' as const,version:2,own:false,evaluations:2,passingEvaluators:0,incompleteEvaluators:2},
 {id:'independently-passed',module:'leave' as const,version:3,own:false,evaluations:2,passingEvaluators:2,incompleteEvaluators:0}],
 promotions:[],ownSignalChoices:[{id:'own-verified-signal',module:'leave' as const,outcome:'needs_correction' as const,createdAt:'2026-01-01'}],signalChoicesTruncated:true};}
describe('specialist human governance presentation',()=>{
 it('keeps own candidates out of independent evaluation and incomplete candidates out of promotion',async()=>{
  const{container}=render(await ModuleSpecialistReview({view:view()}));
  const selects=container.querySelectorAll<HTMLSelectElement>('select[name="candidateId"]');expect(selects).toHaveLength(2);
  expect(Array.from(selects[0].options).map(option=>option.value)).toEqual(['missing-domain','independently-passed']);
  expect(Array.from(selects[1].options).map(option=>option.value)).toEqual(['independently-passed']);
  const evaluation=selects[0].closest('form')!;expect(within(evaluation).getByRole('checkbox')).toBeRequired();expect(within(evaluation).getByRole('checkbox')).not.toBeChecked();
  expect(container.querySelector('input[name="maxJobs"]')).toHaveAttribute('max','100');expect(container.querySelector('input[name="hours"]')).toHaveAttribute('max','24');
 });
 it('offers optional own feedback selection without rendering ratings as correctness evidence',async()=>{
  const{container}=render(await ModuleSpecialistReview({view:view()}));
  const signal=container.querySelector<HTMLInputElement>('input[name="signalId"]')!;expect(signal.value).toBe('own-verified-signal');expect(signal.checked).toBe(false);expect(signal.required).toBe(false);
  expect(screen.getByText('assistant.workspace.specialists.signalsConsent')).toBeInTheDocument();
  expect(screen.getByText('assistant.workspace.specialists.signalsTruncated')).toBeInTheDocument();
  expect(container.querySelector('[name="qualityScore"]')).toBeNull();expect(container.querySelector('[name="securityFailures"]')).toBeNull();
 });
 it('uses a separate explicit human POST and nonce rather than consuming a permit through a GET link',async()=>{
  const{container}=render(await SpecialistJobComposer({modules:['leave','claims']}));
  const select=screen.getByRole('combobox');expect(Array.from((select as HTMLSelectElement).options).map(option=>option.value)).toEqual(['','leave','claims']);
  expect(container.querySelector<HTMLInputElement>('input[name="commandNonce"]')?.value).toMatch(/^[a-f0-9-]{36}$/i);
  expect(container.querySelector('a')).toBeNull();expect(container.querySelector('input[name="employmentId"]')).toBeNull();expect(container.querySelector('input[name="execute"]')).toBeNull();
 });
 it('does not offer specialist execution when no module is available',async()=>{
  render(await SpecialistJobComposer({modules:[]}));expect(screen.getByRole('button')).toBeDisabled();
 });
 it('shows unavailable evaluation evidence as unknown rather than zero or a promotion pass',async()=>{
  const v={...view(),candidates:view().candidates.map(row=>({...row,evaluations:null,passingEvaluators:null,incompleteEvaluators:null}))};
  const{container}=render(await ModuleSpecialistReview({view:v}));expect(screen.getAllByText('assistant.workspace.specialists.evaluationsUnknown')).toHaveLength(3);
  expect(container.querySelectorAll('select[name="candidateId"]')).toHaveLength(1);expect(screen.queryByText(/specialists\.passing/)).toBeNull();
 });
});
