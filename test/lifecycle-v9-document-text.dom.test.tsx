import { beforeAll,expect,it,vi } from 'vitest';
import { fireEvent,render,screen,waitFor } from '@testing-library/react';
import { DocumentTextEditor } from '../app/(app)/lifecycle/v9/document-text-editor';
import type { Document } from '../lib/lifecycle-v9-model';
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
const document:Document={id:'doc',templateId:'template',name:'Fictional letter',version:1,status:'draft',blocks:[{id:'title',type:'heading',text:'Template title',section:''},{id:'body',type:'text',text:'For {employee.name}',section:''},{id:'signature',type:'signature',text:'',label:'Signature',section:''}],fields:[],values:{},edits:{},hrSignature:null,employeeSignature:null,createdAt:'',sentAt:null,mergeValues:{'employee.name':'Fictional person'}};
it('previews per-person wording and sends only saved-instance edits',async()=>{
  const command=vi.fn(async()=>({ok:true})),close=vi.fn();render(<DocumentTextEditor document={document} person="Fictional person" busy={false} command={command} close={close}/>);
  expect(screen.getByText('For Fictional person only. The template does not change.')).toBeVisible();
  fireEvent.change(screen.getByLabelText('Title'),{target:{value:'Reviewed title'}});fireEvent.click(screen.getByRole('button',{name:'Preview'}));expect(screen.getByRole('heading',{name:'Reviewed title'})).toBeVisible();expect(screen.getByText('For Fictional person')).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'Done'}));await waitFor(()=>expect(close).toHaveBeenCalledOnce());expect(command).toHaveBeenCalledWith({type:'documentTextEdit',id:'doc',edits:{title:'Reviewed title'}});expect(document.edits).toEqual({});
});
it('retains wording on a save failure and resets only instance text',async()=>{
  const command=vi.fn(async()=>({ok:false,error:'Controlled save conflict'})),close=vi.fn();render(<DocumentTextEditor document={{...document,edits:{body:'Earlier personal wording'}}} person="Fictional person" busy={false} command={command} close={close}/>);
  fireEvent.change(screen.getByLabelText('Text'),{target:{value:'Unsaved wording'}});fireEvent.click(screen.getByRole('button',{name:'Done'}));await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Controlled save conflict'));expect(screen.getByLabelText('Text')).toHaveValue('Unsaved wording');expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Reset to template'}));expect(screen.getByLabelText('Text')).toHaveValue('For {employee.name}');fireEvent.click(screen.getByRole('button',{name:'Done'}));await waitFor(()=>expect(command).toHaveBeenLastCalledWith({type:'documentTextEdit',id:'doc',edits:{}}));
});
