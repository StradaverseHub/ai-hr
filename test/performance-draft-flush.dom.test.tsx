// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const ports=vi.hoisted(()=>({save:vi.fn()}));
vi.mock('../app/performance/onehr-actions',()=>({saveAssessmentDraftAction:ports.save}));
import { AssessmentDraftForm, flushAssessmentDrafts } from '../app/performance/onehr/draft-form';
const labels={saving:'Saving',saved:'Saved',privateDraft:'Private',failed:'Could not save'};
beforeEach(()=>{vi.useFakeTimers();ports.save.mockReset().mockResolvedValue({revision:1,updatedAt:new Date()});});
afterEach(()=>{cleanup();vi.clearAllTimers();vi.useRealTimers();});
describe('assessment composer draft ordering',()=>{
 it('flushes a pending widget save before chat reads the draft, without waiting for the debounce',async()=>{
  render(<AssessmentDraftForm revision={null} action={vi.fn()} labels={labels}><label>Result<input name="actual" defaultValue=""/></label></AssessmentDraftForm>);
  fireEvent.change(screen.getByLabelText('Result'),{target:{value:'100'}});
  expect(ports.save).not.toHaveBeenCalled();
  await act(async()=>{await flushAssessmentDrafts();});
  expect(ports.save).toHaveBeenCalledOnce();expect((ports.save.mock.calls[0][0] as FormData).get('actual')).toBe('100');
  expect((ports.save.mock.calls[0][0] as FormData).get('draftRevision')).toBe('');
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(ports.save).toHaveBeenCalledOnce();
 });
 it('prevents chat from proceeding when an active widget could not save',async()=>{
  ports.save.mockResolvedValue({error:'Draft changed'});
  render(<AssessmentDraftForm revision={1} action={vi.fn()} labels={labels}><label>Result<input name="actual" defaultValue=""/></label></AssessmentDraftForm>);
  fireEvent.change(screen.getByLabelText('Result'),{target:{value:'100'}});
  await act(async()=>{await expect(flushAssessmentDrafts()).rejects.toThrow('Draft changed');});
  expect(screen.getByRole('alert').textContent).toBe('Draft changed');
 });
});
