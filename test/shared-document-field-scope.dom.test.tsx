import {expect,it,vi} from 'vitest';
import {fireEvent,render,screen} from '@testing-library/react';
import {DocumentBody} from '../components/lifecycle-v9/document-body';
import type {Document,Field} from '../lib/lifecycle-v9-model';
const field=(id:string,patch:Partial<Field>={}):Field=>({id,label:id,type:'text',owner:'hr',pmKey:null,required:false,sensitive:false,options:[],section:'details',when:null,width:'full',columns:[],...patch});
const fields=[field('Editable answer'),field('Other owner field'),field('Personnel name',{owner:'pmLocked'}),field('Mapped position',{pmKey:'employee.position'})];
const document:Document={id:'document',templateId:'template',version:1,name:'Scoped form',status:'sent',fields,blocks:[{id:'fields',type:'fields',text:'',section:'details'}],values:{'Personnel name':'Recorded name','Mapped position':'Recorded role'},edits:{},hrSignature:null,employeeSignature:null,createdAt:'2026-11-18T00:00:00Z',sentAt:'2026-11-18T00:00:00Z'};
it.each(['array','set'] as const)('limits %s field scopes to authorized unbound answers and honors disabled state',kind=>{
 const allowed=['Editable answer','Personnel name','Mapped position'],scope=kind==='set'?new Set(allowed):allowed,change=vi.fn();
 const view=render(<DocumentBody document={document} editableBy="employee" editableFieldIds={scope} change={change}/>);
 expect(screen.getByLabelText('Editable answer')).toBeEnabled();expect(screen.getByLabelText('Other owner field')).toBeDisabled();
 expect(screen.getByLabelText(/Personnel name/)).toBeDisabled();expect(screen.getByLabelText('Mapped position')).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Editable answer'),{target:{value:'Reviewed answer'}});expect(change).toHaveBeenCalledWith('Editable answer','Reviewed answer');
 view.rerender(<DocumentBody document={document} editableBy="employee" editableFieldIds={scope} disabled change={change}/>);
 expect(screen.getByLabelText('Editable answer')).toBeDisabled();expect(screen.getByLabelText(/Personnel name/)).toHaveValue('Recorded name');expect(screen.getByLabelText('Mapped position')).toHaveValue('Recorded role');
});
