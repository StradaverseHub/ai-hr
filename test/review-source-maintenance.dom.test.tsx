/** Only the source-date form follows Workforce maintenance; independent review actions retain their owner. */
import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
const state=vi.hoisted(()=>({endDate:null as string|null}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>Object.assign((key:string)=>namespace+'.'+key,{has:()=>false})}));
vi.mock('../core/employment-review',()=>({
 reviewProfile:async()=>({employmentType:'full_time',reviewType:'probation',endDate:state.endDate,dueDate:null,openReview:null}),
 reviewsFor:async()=>[],reviewDocumentsFor:async()=>[],
}));
vi.mock('../app/admin/personnel/[employmentId]/actions',()=>({saveReviewLetterAction:vi.fn(),setReviewEndDateAction:vi.fn(),startReviewAction:vi.fn(),uploadReviewDocumentAction:vi.fn()}));
vi.mock('../components/ui/date-field',()=>({DateField:({name,label}:{name?:string;label?:string})=><input type="date" name={name} aria-label={label}/>}));
import {ReviewSection} from '../app/admin/personnel/[employmentId]/review-section';
const s:SessionContext={tenantId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222',roles:['hr_admin']};
const employmentId='33333333-3333-4333-8333-333333333333';
afterEach(cleanup);beforeEach(()=>{state.endDate=null;});
describe('review source-date maintenance affordance',()=>{
 it('shows read-only feedback and omits the source-date form after maintenance denial',async()=>{
  const {container}=render(await ReviewSection({s,employmentId,canMaintain:false}));
  expect(screen.getByRole('status').textContent).toBe('accessConfiguration.workforceReadOnly');
  expect(screen.queryByRole('button',{name:'review.setEndDate'})).toBeNull();expect(container.querySelector('form')).toBeNull();
 });
 it('keeps the source-date form for an authorized maintainer',async()=>{
  render(await ReviewSection({s,employmentId,canMaintain:true}));
  expect(screen.getByRole('button',{name:'review.setEndDate'})).toBeDefined();
 });
 it('keeps independently authorized review initiation separate from source-date maintenance',async()=>{
  state.endDate='2026-06-15';render(await ReviewSection({s,employmentId,canMaintain:false}));
  expect(screen.getByRole('button',{name:'review.startReview'})).toBeDefined();
  expect(screen.queryByRole('button',{name:'review.setEndDate'})).toBeNull();
 });
});
