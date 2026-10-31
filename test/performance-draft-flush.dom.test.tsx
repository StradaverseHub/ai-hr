// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const ports=vi.hoisted(()=>({save:vi.fn()}));
vi.mock('../app/(app)/performance/onehr-actions',()=>({saveAssessmentDraftAction:ports.save}));
import { AssessmentDraftForm, flushAssessmentDrafts } from '../app/(app)/performance/onehr/draft-form';
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
 it('flushes structural scorecard edits through the supplied owner and carries its current revision forward',async()=>{
  const settingSave=vi.fn().mockResolvedValueOnce({revision:4}).mockResolvedValue({revision:5}),action=vi.fn();
  const form=(key:string,second=false)=><AssessmentDraftForm revision={3} changeKey={key} save={settingSave} action={action} labels={labels}><input type="hidden" name="kpiId" value="first"/>{second&&<input type="hidden" name="kpiId" value="second"/>}<label>Target<input name="target" defaultValue="100"/></label></AssessmentDraftForm>;
  const ui=render(form('first'));ui.rerender(form('first|second',true));
  await act(async()=>{await flushAssessmentDrafts();});
  expect(settingSave).toHaveBeenCalledOnce();expect(ports.save).not.toHaveBeenCalled();
  expect((settingSave.mock.calls[0][0] as FormData).getAll('kpiId')).toEqual(['first','second']);expect((settingSave.mock.calls[0][0] as FormData).get('draftRevision')).toBe('3');
  fireEvent.change(screen.getByLabelText('Target'),{target:{value:''}});await act(async()=>{await flushAssessmentDrafts();});
  expect((settingSave.mock.calls[1][0] as FormData).get('target')).toBe('');expect((settingSave.mock.calls[1][0] as FormData).get('draftRevision')).toBe('4');
 });
 it('prevents chat from proceeding when an active widget could not save',async()=>{
  ports.save.mockResolvedValue({error:'Draft changed'});
  render(<AssessmentDraftForm revision={1} action={vi.fn()} labels={labels}><label>Result<input name="actual" defaultValue=""/></label></AssessmentDraftForm>);
  fireEvent.change(screen.getByLabelText('Result'),{target:{value:'100'}});
  await act(async()=>{await expect(flushAssessmentDrafts()).rejects.toThrow('Draft changed');});
  expect(screen.getByRole('alert').textContent).toBe('Draft changed');
 });
});
