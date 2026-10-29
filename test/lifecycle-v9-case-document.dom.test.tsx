import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CaseDocument } from '../app/lifecycle/v9/case-document';
import {v9Defaults} from '../lib/lifecycle-v9-defaults';
import type { Document } from '../lib/lifecycle-v9-model';

const actor = { id: 'actual-hr', name: 'HR Reviewer' };
function document(): Document { return { id: 'document', templateId: 'template', version: 1, name: 'Review', status: 'draft', blocks: [{ id: 'field', type: 'field', text: '', section: 'main', fieldId: 'note' }], fields: [{ id: 'note', label: 'HR note', type: 'text', owner: 'hr', pmKey: null, required: true, sensitive: false, options: [], section: 'main', when: null }], values: { note: 'Original' }, edits: {}, hrSignature: null, employeeSignature: null, createdAt: '', sentAt: null, hrStep: 'before', signatoryUserId: actor.id }; }
it('saves only HR fields and holds signing while edits are unsaved', () => {
  const command = vi.fn(), doc = document();
  render(<CaseDocument c={{ state: 'submitted' }} document={doc} actor={actor} busy={false} command={command}/>);
  fireEvent.change(screen.getByLabelText('HR note *'), { target: { value: 'Reviewed answer' } });
  expect(screen.getByRole('button', { name: 'Sign and submit' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save HR fields' }));
  expect(command).toHaveBeenCalledWith({ type: 'documentSave', id: doc.id, values: { note: 'Reviewed answer' } });
});
it('offers countersigning to an authorized HR reviewer and keeps employee answers read-only', () => {
  const doc = document(); doc.status = 'countersign'; doc.hrStep = 'after'; doc.employeeSignature = { by: { id: 'employee', name: 'Employee' }, at: '2026-10-29T00:00:00Z', method: 'typed', value: 'Employee', consent: true };
  const command = vi.fn(), view = render(<CaseDocument c={{ state: 'submitted' }} document={doc} actor={{ id: 'other', name: 'Other HR' }} busy={false} command={command}/>);
  expect(screen.getByRole('button', { name: 'Sign and submit' })).toBeVisible();
  expect(screen.getByLabelText('HR note *')).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Sign and submit' }));
  expect(command).toHaveBeenCalledWith({ type: 'documentSign', id: doc.id, signature: { method: 'typed', value: 'Other HR', consent: true } });
  view.rerender(<CaseDocument c={{ state: 'cancelled' }} document={doc} actor={actor} busy={false} command={command}/>);
  expect(screen.queryByRole('button', { name: 'Sign and submit' })).not.toBeInTheDocument();
});
it('offers per-person wording only while the instance is an unsigned unreserved draft',()=>{
  const doc=document();doc.blocks.unshift({id:'body',type:'text',text:'Draft wording',section:''});
  const command=vi.fn(),view=render(<CaseDocument c={{state:'submitted'}} document={doc} actor={actor} busy={false} command={command}/>);
  expect(screen.getByRole('button',{name:'Edit for this person'})).toBeEnabled();
  doc.status='sent';view.rerender(<CaseDocument c={{state:'submitted'}} document={doc} actor={actor} busy={false} command={command}/>);expect(screen.queryByRole('button',{name:'Edit for this person'})).not.toBeInTheDocument();
  doc.status='draft';view.rerender(<CaseDocument c={{state:'submitted',mails:[{id:'mail',key:'mail',workflowId:null,templateId:null,to:['employee'],cc:[],subject:'Fictional',body:'',documentIds:[doc.id],fileIds:[],status:'uncertain',test:false,at:'',deliveredAt:null,failure:null}]}} document={doc} actor={actor} busy={false} command={command}/>);expect(screen.queryByRole('button',{name:'Edit for this person'})).not.toBeInTheDocument();
});

it('offers the company permitted list for an unsigned instance without changing the default',()=>{
  const config=v9Defaults(),doc=document(),command=vi.fn();config.companies=[{companyId:'company',signatoryUserId:actor.id,signatoryTitle:'HR',allowedSignatoryUserIds:[actor.id,'alternate']}];
  const view=render(<CaseDocument c={{state:'submitted',facts:{company:'company'} as never}} document={doc} config={config} users={[actor,{id:'alternate',name:'Alternate HR'},{id:'outside',name:'Other company HR'}]} actor={actor} busy={false} command={command}/>);
  expect(screen.queryByRole('option',{name:'Other company HR'})).not.toBeInTheDocument();fireEvent.change(screen.getByRole('combobox',{name:'HR signatory for this document'}),{target:{value:'alternate'}});expect(command).toHaveBeenCalledExactlyOnceWith({type:'documentSignatory',id:doc.id,userId:'alternate'});expect(config.companies[0].signatoryUserId).toBe(actor.id);
  view.rerender(<CaseDocument c={{state:'submitted'}} document={{...doc,status:'hrsigned'}} config={config} actor={actor} busy={false} command={command}/>);expect(screen.queryByRole('combobox',{name:'HR signatory for this document'})).not.toBeInTheDocument();
});

it('shows signing rejection inside the open document and retains the signature input',async()=>{
  const doc=document(),command=vi.fn().mockResolvedValue({ok:false,error:'Complete missing Personnel and Leave details.'});
  render(<CaseDocument c={{state:'submitted'}} document={doc} actor={actor} busy={false} command={command}/>);
  fireEvent.change(screen.getByRole('textbox',{name:'Type your full name'}),{target:{value:'Fictional reviewer'}});fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Sign and submit'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Complete missing Personnel and Leave details.');expect(screen.getByRole('alert')).toHaveFocus();expect(screen.getByRole('textbox',{name:'Type your full name'})).toHaveValue('Fictional reviewer');expect(doc.hrSignature).toBeNull();
});

it('limits the shared permitted signer list to the actual module candidates',()=>{
 const config=v9Defaults(),doc=document();config.companies=[{companyId:'company',signatoryUserId:actor.id,signatoryTitle:'HR',allowedSignatoryUserIds:[actor.id,'other-module']}];
 render(<CaseDocument c={{state:'submitted',facts:{company:'company'} as never}} document={doc} config={config} eligibleSignatoryIds={[actor.id]} users={[actor,{id:'other-module',name:'Other module HR'}]} actor={actor} busy={false} command={vi.fn()}/>);
 expect(screen.queryByRole('option',{name:'Other module HR'})).not.toBeInTheDocument();expect(screen.getByRole('option',{name:'HR Reviewer (company default)'})).toBeInTheDocument();
});
