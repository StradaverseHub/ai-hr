import type {ReactNode} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {PersonnelCompletionDocumentBody,PersonnelCompletionPanel,PersonnelCompletionInventory} from '../components/lifecycle-v9/personnel-completion';
import {PersonnelReview} from '../app/lifecycle/v9/personnel-review';
import {initializePersonnelCompletion,reconcilePersonnelCompletion} from '../lib/lifecycle-v9-personnel-completion';
import {completionDocument,completionReviewCase,completionActor} from './helpers/personnel-completion-ui-fixture';
afterEach(cleanup);
const view=(content:ReactNode)=><NextIntlClientProvider locale="en" messages={messages}>{content}</NextIntlClientProvider>;
it('opens only missing personal fields, annotates their source and rejects invalid phone answers accessibly',()=>{
 const document=completionDocument(),change=vi.fn();const result=render(view(<PersonnelCompletionDocumentBody document={document} editableBy="employee" change={change}/>));
 expect(screen.getByRole('textbox',{name:'Address *'})).toBeEnabled();expect(screen.getByRole('textbox',{name:'Work email *'})).toBeDisabled();expect(screen.getByRole('textbox',{name:/Passport number/})).toBeDisabled();
 expect(screen.getAllByText(messages.personnelCompletion.missingPersonalNote)).toHaveLength(2);
 fireEvent.blur(screen.getByRole('textbox',{name:'Address *'}));expect(screen.getByRole('alert')).toHaveTextContent('Complete this required field.');
 result.rerender(view(<PersonnelCompletionDocumentBody document={document} values={{...document.values,mobile:'12345'}} editableBy="employee" change={change}/>));fireEvent.blur(screen.getByRole('textbox',{name:'Mobile phone'}));expect(screen.getByRole('textbox',{name:'Mobile phone'})).toHaveAttribute('aria-invalid','true');expect(screen.getByText(messages.personnelCompletion.validationPhone)).toBeVisible();
});
it('locks a newly available official value while retaining and reporting the employee draft conflict',()=>{
 const document=completionDocument();document.values['address-answer']='Fictional saved employee answer';
 reconcilePersonnelCompletion(document,{values:{'address-answer':'Fictional official PM address',passport:'Fictional passport in PM'},sourceFingerprint:'new-source',actor:completionActor,at:'2026-11-18T02:00:00.000Z'});
 render(view(<><PersonnelCompletionDocumentBody document={document} values={{...document.values,'address-answer':'Stale local answer'}} editableBy="employee"/><PersonnelCompletionPanel document={document}/></>));
 expect(screen.getByRole('textbox',{name:/Address/})).toHaveValue('Fictional official PM address');expect(screen.getByRole('textbox',{name:/Address/})).toBeDisabled();expect(screen.getByText('Fictional saved employee answer')).toBeVisible();expect(screen.getByText('Address: Fictional official PM address')).toBeVisible();expect(screen.getAllByText(messages.personnelCompletion.conflictHelp).length).toBeGreaterThan(0);
});
it('records an explicit per-field HR assignment reason and retains it if the guarded save is refused',async()=>{
 const override=vi.fn().mockResolvedValue({ok:false});render(view(<PersonnelCompletionPanel document={completionDocument()} canOverride onOverride={override}/>));
 const field=within(screen.getByRole('group',{name:'Work email'}));fireEvent.click(field.getByRole('button',{name:'Ask the employee'}));expect(field.getByRole('button',{name:'Confirm change'})).toBeDisabled();
 fireEvent.change(field.getByRole('textbox',{name:messages.personnelCompletion.reason}),{target:{value:'Fictional employee knows this answer'}});fireEvent.click(field.getByRole('button',{name:'Confirm change'}));
 await waitFor(()=>expect(override).toHaveBeenCalledExactlyOnceWith({fieldId:'workEmail',owner:'employee',reason:'Fictional employee knows this answer'}));expect(await field.findByRole('alert')).toHaveTextContent(messages.personnelCompletion.saveFailed);expect(field.getByRole('textbox')).toHaveValue('Fictional employee knows this answer');
});
it('makes the employee personal-field override explicit and defaults HR controls to no authority',()=>{
 render(view(<PersonnelCompletionPanel document={completionDocument()}/>));expect(within(screen.getByRole('group',{name:'Address'})).getByRole('button',{name:'Fill it myself'})).toBeDisabled();
});
it('retains invalid HR scalar input for correction instead of sending an invalid command',()=>{
 const save=vi.fn();render(view(<PersonnelCompletionPanel document={completionDocument()} onSave={save}/>));fireEvent.change(screen.getByRole('textbox',{name:'Work email *'}),{target:{value:'not-an-email'}});expect(screen.getByRole('alert')).toHaveTextContent(messages.personnelCompletion.validationEmail);expect(screen.getByRole('button',{name:messages.personnelCompletion.saveHR})).toBeDisabled();expect(save).not.toHaveBeenCalled();
});
it('keeps signed snapshots readonly even with stale local values or HR authority',()=>{
 const document=completionDocument();document.status='signed';document.employeeSignature={method:'typed',value:'Fictional signature',consent:true,at:'2026-11-18T03:00:00.000Z',by:completionActor};
 render(view(<><PersonnelCompletionDocumentBody document={document} values={{...document.values,'address-answer':'Unsaved injection'}} editableBy="employee"/><PersonnelCompletionPanel document={document} canOverride onOverride={vi.fn()}/></>));expect(screen.getByRole('textbox',{name:'Address *'})).toHaveValue('');expect(screen.getByRole('textbox',{name:'Address *'})).toBeDisabled();expect(within(screen.getByRole('group',{name:'Address'})).getByRole('button',{name:'Fill it myself'})).toBeDisabled();
});
it('shows actual missing-PM provenance and pushes only explicitly selected proposals through the existing command',()=>{
 const command=vi.fn();render(view(<PersonnelReview c={completionReviewCase()} writableKeys={['address']} busy={false} command={command}/>));expect(screen.getByText('Not in PM')).toBeVisible();expect(screen.getByText('Fictional employee')).toBeVisible();
 fireEvent.click(screen.getByRole('checkbox',{name:'Push Address to Personnel Management'}));expect(screen.getByRole('button',{name:'Push 0 changes to PM'})).toBeDisabled();expect(command).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Keep on case only'}));expect(command).toHaveBeenCalledExactlyOnceWith({type:'pmKeep',ids:['fictional-proposal']});
});
it('reports all twenty approved fields as eleven personal and nine employment without offering a template setting',()=>{
 render(view(<PersonnelCompletionInventory/>));fireEvent.click(screen.getByText(messages.personnelCompletion.inventoryTitle));const lists=screen.getAllByRole('list');expect(within(lists[0]).getAllByRole('listitem')).toHaveLength(11);expect(within(lists[1]).getAllByRole('listitem')).toHaveLength(9);expect(screen.queryByRole('combobox')).toBeNull();
});

it('keeps an unclassified linked field with HR until its classification is explicitly extended',()=>{
 const document=completionDocument();document.fields.push({...document.fields[0],id:'unknown-answer',label:'Fictional unclassified link',pmKey:'case.newField'});document.values['unknown-answer']='';delete document.personnelCompletion;
 initializePersonnelCompletion(document,{country:'MY',sourceFingerprint:'unknown-link-source',officialValues:{passport:'Fictional passport in PM'},actor:completionActor,at:'2026-11-18T00:00:00.000Z'});
 const rendered=render(view(<PersonnelCompletionDocumentBody document={document} editableBy="employee"/>));expect(screen.getByRole('textbox',{name:'Fictional unclassified link *'})).toBeDisabled();rendered.unmount();
 render(view(<PersonnelCompletionPanel document={document} canOverride onOverride={vi.fn()} onSave={vi.fn()}/>));expect(within(screen.getByRole('group',{name:'Fictional unclassified link'})).queryByRole('button',{name:'Ask the employee'})).toBeNull();expect(screen.getByRole('textbox',{name:'Fictional unclassified link *'})).toBeEnabled();
});

it('shows an exact locked Personnel select value even if the template options do not include it',()=>{
 const document=completionDocument(),field=document.fields.find(field=>field.id==='passport')!;field.type='select';field.options=['Fictional different option'];render(view(<PersonnelCompletionDocumentBody document={document} editableBy="employee"/>));const input=screen.getByRole('combobox',{name:/Passport number/});expect(input).toBeDisabled();expect(input).toHaveValue('Fictional passport in PM');expect((within(input).getByRole('option',{name:'Fictional passport in PM'})as HTMLOptionElement).selected).toBe(true);
});

it('labels whitespace-only previous Personnel values as missing during HR review',()=>{
 const c=completionReviewCase();c.pmChanges[0].before='   ';render(view(<PersonnelReview c={c} writableKeys={['address']} busy={false} command={vi.fn()}/>));expect(screen.getByText('Not in PM')).toBeVisible();
});
