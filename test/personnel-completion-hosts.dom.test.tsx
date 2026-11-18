import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {EmployeeLifecycle} from '../app/me/lifecycle/view';
import {CaseDocument} from '../app/lifecycle/v9/case-document';
import {completionDocument,completionActor} from './helpers/personnel-completion-ui-fixture';
import type {LifecycleV9OwnCase} from '../packs/lifecycle/service';
import messages from '../messages/en.json';
const actions=vi.hoisted(()=>({submit:vi.fn(),save:vi.fn(),open:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:actions.refresh})}));
vi.mock('../app/me/lifecycle/actions',()=>({submitOwnLifecycleCompletion:actions.submit,saveOwnLifecycleDocument:actions.save,openLifecycleDocument:actions.open}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
function ownDocument(){const doc=completionDocument();doc.personnelCompletion!.preparation={by:completionActor,at:'2026-11-18T01:00:00.000Z'};return doc;}
function view(){const doc=ownDocument(),c={id:'case',revision:3,state:'submitted',own:true,documents:[doc],facts:{name:'Fictional employee'},items:[],tasks:[]} as unknown as LifecycleV9OwnCase;render(<NextIntlClientProvider locale="en" messages={messages}><EmployeeLifecycle cases={[c]} initialSelection={{caseId:c.id,documentId:doc.id}}/></NextIntlClientProvider>);return doc;}
it('prepares only employee fields without exposing unreleased wording, PDFs or signatures and submits separately from signing',async()=>{
 actions.submit.mockResolvedValue({ok:true});const doc=view();
 expect(screen.queryByRole('link',{name:'Download PDF'})).not.toBeInTheDocument();expect(screen.queryByText('Address:')).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Sign and submit'})).not.toBeInTheDocument();expect(screen.queryByRole('textbox',{name:/Work email/})).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Submit answers'})).toBeDisabled();fireEvent.change(screen.getByRole('textbox',{name:'Address *'}),{target:{value:'Fictional entered address'}});fireEvent.click(screen.getByRole('button',{name:'Submit answers'}));
 await waitFor(()=>expect(actions.submit).toHaveBeenCalledWith({caseId:'case',revision:3,documentId:doc.id,values:{'address-answer':'Fictional entered address',mobile:''}}));expect(actions.save).not.toHaveBeenCalled();expect(actions.open).not.toHaveBeenCalled();expect(await screen.findByText(messages.personnelCompletion.answersSubmitted)).toBeVisible();
});
it('keeps the employee preparation draft after a failed submission',async()=>{
 actions.submit.mockResolvedValue({ok:false,error:messages.personnelCompletion.saveFailed});view();fireEvent.change(screen.getByRole('textbox',{name:'Address *'}),{target:{value:'Retained draft'}});fireEvent.click(screen.getByRole('button',{name:'Submit answers'}));expect(await screen.findByRole('alert')).toHaveTextContent(messages.personnelCompletion.saveFailed);expect(screen.getByRole('textbox',{name:'Address *'})).toHaveValue('Retained draft');
});
it('uses the HR case command for an audited completion override rather than changing template ownership',async()=>{
 const doc=ownDocument(),command=vi.fn().mockResolvedValue({ok:true});render(<NextIntlClientProvider locale="en" messages={messages}><CaseDocument c={{state:'submitted'}} document={doc} actor={{id:'hr',name:'Fictional HR'}} busy={false} command={command}/></NextIntlClientProvider>);
 fireEvent.click(screen.getAllByRole('button',{name:'Fill it myself'})[0]);fireEvent.change(screen.getByRole('textbox',{name:messages.personnelCompletion.reason}),{target:{value:'Employee asked HR to enter the supplied address'}});fireEvent.click(screen.getByRole('button',{name:'Confirm change'}));await waitFor(()=>expect(command).toHaveBeenCalledWith({type:'documentCompletionOverride',id:doc.id,fieldId:'address-answer',owner:'hr',reason:'Employee asked HR to enter the supplied address'}));expect(doc.fields[0].owner).toBe('pmLocked');
});
