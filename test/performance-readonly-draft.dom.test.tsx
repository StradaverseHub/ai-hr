// @vitest-environment jsdom
import React from 'react';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {render,screen,cleanup,fireEvent} from '@testing-library/react';
vi.mock('../app/(app)/performance/onehr-actions',()=>({saveAssessmentDraftAction:vi.fn()}));
import {AssessmentDraftForm,flushAssessmentDrafts} from '../app/(app)/performance/onehr/draft-form';
afterEach(cleanup);
describe('submitted assessment view',()=>{
 it('shows the retained reflection without a form, draft privacy claim or autosave',async()=>{
  const save=vi.fn(),action=vi.fn();const {container}=render(<AssessmentDraftForm readOnly revision={null} save={save} action={action} labels={{saving:'Saving',saved:'Saved',privateDraft:'Only you can see this draft',failed:'Failed'}}><blockquote>Submitted reflection</blockquote></AssessmentDraftForm>);
  expect(screen.getByText('Submitted reflection')).toBeTruthy();expect(screen.queryByRole('status')).toBeNull();expect(container.querySelector('form')).toBeNull();
  fireEvent.change(screen.getByText('Submitted reflection'));await flushAssessmentDrafts();expect(save).not.toHaveBeenCalled();expect(action).not.toHaveBeenCalled();
 });
});
