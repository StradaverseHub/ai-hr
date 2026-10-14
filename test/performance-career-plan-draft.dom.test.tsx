import React from 'react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
const mocks=vi.hoisted(()=>({generate:vi.fn(),apply:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh})}));
vi.mock('../app/performance/onehr-actions',()=>({careerPlanDraftAction:mocks.generate,applyCareerPlanDraftAction:mocks.apply}));
import { CareerPlanDraft } from '../app/performance/onehr/career-plan-draft';
const result={goals:[{area:'Delivery',itemIds:['gap:Delivery'],onJob:'Lead a retrospective',fromOthers:'Ask a mentor',formalLearning:'Study practice'}],aspirationLong:'Grow my delivery practice',pool:[{id:'gap:Delivery',area:'Delivery',detail:'The chosen role needs level 3.',kind:'stretch',note:'level 3'}],sourceDigest:'source-digest',empty:false,remaining:4,limit:5,resetSeconds:0,used:1};
beforeEach(()=>{vi.clearAllMocks();mocks.generate.mockResolvedValue(result);mocks.apply.mockResolvedValue({ok:true});});afterEach(cleanup);
function show(existingLong=''){
 const submitted=vi.fn();render(<NextIntlClientProvider locale="en" messages={en}><form onSubmit={submitted}><label>Longer-term aspiration<textarea name="aspirationLong" defaultValue={existingLong}/></label><label>Direction<select name="targetProfileId" defaultValue="target"><option value="target">Chosen role</option><option value="other">Other role</option></select></label><label>Mobility<select name="mobility" defaultValue=""><option value="">Choose</option><option value="stay">Stay</option></select></label><input name="goalId" defaultValue="human-goal"/><label>Human goal<textarea name="human-goal.area" defaultValue="My own unsaved goal"/></label><CareerPlanDraft reviewId="review" savedTargetId="target" initialQuota={{remaining:5,limit:5}}/></form></NextIntlClientProvider>);return submitted;
}
it('previews without changing form values or submitting; explicit Keep carries the latest unsaved human fields',async()=>{
 const submitted=show();fireEvent.click(screen.getByRole('button',{name:en.onehr.careerDraft.generate}));await screen.findByText(en.onehr.careerDraft.preview);
 expect(mocks.apply).not.toHaveBeenCalled();expect((screen.getByRole('textbox',{name:'Longer-term aspiration'}) as HTMLTextAreaElement).value).toBe('');expect((screen.getByRole('combobox',{name:'Mobility'}) as HTMLSelectElement).value).toBe('');
 fireEvent.change(screen.getByRole('textbox',{name:'Human goal'}),{target:{value:'My newer unsaved goal'}});fireEvent.click(screen.getByRole('button',{name:en.onehr.careerDraft.keep}));
 await waitFor(()=>expect(mocks.apply).toHaveBeenCalledOnce());const [data,goals,long,sourceDigest]=mocks.apply.mock.calls[0];expect(data.get('human-goal.area')).toBe('My newer unsaved goal');expect(data.get('mobility')).toBe('');expect(goals).toEqual(result.goals);expect(long).toBe(result.aspirationLong);expect(sourceDigest).toBe(result.sourceDigest);expect(submitted).not.toHaveBeenCalled();expect(mocks.refresh).toHaveBeenCalledOnce();
});
it('does not select an AI aspiration over existing human words and discards without saving',async()=>{
 show('My own longer-term words');fireEvent.click(screen.getByRole('button',{name:en.onehr.careerDraft.generate}));await screen.findByText(en.onehr.careerDraft.preview);
 expect((screen.getByRole('checkbox',{name:en.onehr.careerDraft.keepAspiration}) as HTMLInputElement).checked).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:en.onehr.developmentSuggestions.discard}));expect(mocks.apply).not.toHaveBeenCalled();expect((screen.getByRole('textbox',{name:'Longer-term aspiration'}) as HTMLTextAreaElement).value).toBe('My own longer-term words');
});
it('requires the newly chosen direction to be saved before requesting a grounded draft',()=>{
 show();fireEvent.change(screen.getByRole('combobox',{name:'Direction'}),{target:{value:'other'}});fireEvent.click(screen.getByRole('button',{name:en.onehr.careerDraft.generate}));expect(screen.getByRole('alert').textContent).toBe(en.onehr.careerDraft.saveDirection);expect(mocks.generate).not.toHaveBeenCalled();
});
