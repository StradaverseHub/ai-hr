/** @vitest-environment jsdom */
/** Actual control projection only; database source/default qualification remains separate. */
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {ClaimTypePanel} from '../components/claim-type-panel';
afterEach(cleanup);
const action=vi.fn(async(_fd:FormData)=>{});
const source={id:'10000000-0000-4000-8000-000000000001',code:'FICTIONAL',name:'Fictional receipt benefit',description:'Fictional catalogue detail',defaultTaxable:false,requiresReceipt:true,maxReceiptAgeDays:30,isMileage:false,
 items:[{id:'10000000-0000-4000-8000-000000000002',code:'FICTIONAL_ITEM',name:'Fictional dependent item'}],
 formFields:[{id:'10000000-0000-4000-8000-000000000003',fieldKey:'project',label:'Fictional project',kind:'text',required:true,options:[]},{id:'10000000-0000-4000-8000-000000000004',fieldKey:'reference',label:'Fictional reference',kind:'text',required:false,options:[]}],fieldKinds:['text','select'],
 updateAction:action,archiveAction:action,deleteAction:action,createItemAction:action,updateItemAction:action,archiveItemAction:action,createFieldAction:action,updateFieldAction:action,moveFieldAction:action,archiveFieldAction:action};
function open(flags:{canAdd:boolean;canEdit:boolean;canDelete:boolean}){
 render(<NextIntlClientProvider locale="en" messages={en}><ul><ClaimTypePanel {...source} {...flags}/></ul></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:/Fictional receipt benefit/}));
}
it('renders the actual catalogue fields while every mutation control is disabled for View only',()=>{
 open({canAdd:false,canEdit:false,canDelete:false});
 expect(screen.getByDisplayValue('Fictional catalogue detail')).toBeTruthy();expect(screen.getByDisplayValue('Fictional project')).toBeTruthy();
 const fieldsets=Array.from(document.querySelectorAll<HTMLFieldSetElement>('fieldset'));expect(fieldsets).toHaveLength(13);
 for(const fieldset of fieldsets){expect(fieldset.disabled).toBe(true);for(const button of fieldset.querySelectorAll('button'))expect(button.matches(':disabled')).toBe(true);}
 expect(action).not.toHaveBeenCalled();
});
it.each(['add','edit','delete'] as const)('enables only the projected %s course across type, item and designed-field controls',course=>{
 open({canAdd:course==='add',canEdit:course==='edit',canDelete:course==='delete'});
 const expected={add:2,edit:6,delete:5};
 const enabled=Array.from(document.querySelectorAll<HTMLFieldSetElement>('fieldset')).filter(fieldset=>!fieldset.disabled);expect(enabled).toHaveLength(expected[course]);
 const labels={add:[en.admin.claims.newItem,en.admin.claims.addField],edit:[en.admin.claims.save,en.admin.claims.moveUp,en.admin.claims.moveDown],delete:[en.admin.claims.archive,en.admin.claims.delete,en.admin.claims.removeField]};
 for(const purpose of ['add','edit','delete'] as const)for(const label of labels[purpose])for(const button of screen.getAllByRole('button',{name:label}))expect(button.matches(':disabled')).toBe(purpose!==course);
 // Each enabled form has a real native control, rather than an empty wrapper passing by coincidence.
 for(const fieldset of enabled){expect(fieldset.querySelector('form')).toBeTruthy();expect(fieldset.querySelector('button')?.matches(':disabled')).toBe(false);}
 for(const fieldset of Array.from(document.querySelectorAll<HTMLFieldSetElement>('fieldset')).filter(fieldset=>fieldset.disabled))for(const button of fieldset.querySelectorAll('button'))expect(button.matches(':disabled')).toBe(true);
 expect(action).not.toHaveBeenCalled();
});
