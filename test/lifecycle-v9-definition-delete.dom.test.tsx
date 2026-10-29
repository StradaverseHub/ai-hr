import { expect,it,vi } from 'vitest';
import { fireEvent,render,screen } from '@testing-library/react';
import { DefinitionDelete,definitionDeleteReason } from '../app/lifecycle/v9/definition-delete';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
it('requires saved usage and keeps the deletion confirmation cancellable',()=>{
  const remove=vi.fn(),view=render(<DefinitionDelete kind="email" name="Fictional email" reason="" saved={false} editable remove={remove}/>);
  expect(screen.getByRole('button',{name:'Delete email'})).toBeDisabled();
  view.rerender(<DefinitionDelete kind="email" name="Fictional email" reason="" saved editable remove={remove}/>);
  fireEvent.click(screen.getByRole('button',{name:'Delete email'}));expect(remove).not.toHaveBeenCalled();expect(screen.getByText('Delete Fictional email?')).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'Cancel deletion'}));expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Delete email'}));fireEvent.click(screen.getByRole('button',{name:'Delete email'}));expect(remove).toHaveBeenCalledOnce();
});
it('explains document, message, frozen-run and current structural dependencies',()=>{
  const config=v9Defaults();
  expect(definitionDeleteReason(config,'email','unused',undefined,undefined)).toContain('Usage');
  expect(definitionDeleteReason(config,'document','unused',[{templateId:'unused',version:1,documents:1}],[])).toContain('Retire');
  expect(definitionDeleteReason(config,'email','unused',[],[{kind:'email',definitionId:'unused',messages:1,runs:0}])).toContain('Turn it off');
  expect(definitionDeleteReason(config,'document','unused',[],[{kind:'document',definitionId:'unused',messages:0,runs:1}])).toContain('workflow history');
  const workflow=config.workflows.find(workflow=>workflow.steps.some(step=>step.type==='email'))!,step=workflow.steps.find(step=>step.type==='email')!;
  if(step.type!=='email')throw Error('Expected email');
  expect(definitionDeleteReason(config,'email',step.template,[],[])).toContain(workflow.name);
  expect(definitionDeleteReason(config,'email','unused',[],[])).toBe('');
  const remove=vi.fn();render(<DefinitionDelete kind="document" name="Used form" reason="Used by documents. Retire it instead." saved editable remove={remove}/>);
  expect(screen.getByRole('button',{name:'Delete template'})).toBeDisabled();expect(screen.getByText('Used by documents. Retire it instead.')).toBeVisible();
});
