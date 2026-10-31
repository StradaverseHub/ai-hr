// @vitest-environment jsdom
import React from 'react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import { testingInstructionDraftFrom } from '../lib/system-testing/editor-model';
import { parseInstructionDraft } from '../lib/system-testing/model';
const actions=vi.hoisted(()=>({save:vi.fn(),observe:vi.fn(),refresh:vi.fn(),replace:vi.fn()}));
vi.mock('../app/(app)/admin/system-testing/workspace-actions',()=>({saveTestingInstructionAction:actions.save,saveTestingObservationAction:actions.observe}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:actions.refresh,replace:actions.replace})}));
import { TestingInstructionEditor } from '../components/system-testing/instruction-editor';
import { TestingObservationForm } from '../components/system-testing/observation-form';
const catalogues={en,ms,zh,ta,th,vi:viMessages};
const id='47335504-b4ad-401b-8d10-59499482ee22';
afterEach(cleanup); beforeEach(()=>vi.clearAllMocks());
function wrap(node:React.ReactNode,locale:keyof typeof catalogues='en') {return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}>{node}</NextIntlClientProvider>);}
function editor() {return wrap(<TestingInstructionEditor initial={testingInstructionDraftFrom(null)} caseId={null} versionId={null} draftRevision={0} modules={[{code:'ess',name:'Fictional ESS'}]} screens={[{screenKey:'dashboard',label:'Fictional Home'}]}/>);}
function payload() {return parseInstructionDraft(JSON.parse((document.querySelector('input[name="definition"]') as HTMLInputElement).value));}
describe('versioned testing controls',()=>{
  it('keeps action/expected pairs and stable step identity through actual add/reorder/remove controls',()=>{
    editor(); fireEvent.change(screen.getByLabelText(en.systemTestingWorkspace.action),{target:{value:'First action'}});fireEvent.change(screen.getByLabelText(en.systemTestingWorkspace.expected),{target:{value:'First expected'}});
    fireEvent.click(screen.getByRole('button',{name:en.systemTestingWorkspace.addStep}));
    const actionsFields=screen.getAllByLabelText(en.systemTestingWorkspace.action),expectedFields=screen.getAllByLabelText(en.systemTestingWorkspace.expected);
    fireEvent.change(actionsFields[1],{target:{value:'Second action'}});fireEvent.change(expectedFields[1],{target:{value:'Second expected'}});
    const original=payload().steps;
    fireEvent.click(screen.getByRole('button',{name:en.systemTestingWorkspace.moveUp.replace('{number}','2')}));
    expect(payload().steps).toEqual([original[1],original[0]]);
    fireEvent.click(screen.getAllByRole('button',{name:en.systemTestingWorkspace.remove})[1]);
    expect(payload().steps).toEqual([original[1]]); expect(actions.save).not.toHaveBeenCalled();
  });
  it('retains typed content and the opened revision when an unrelated refresh supplies a newer observation',()=>{
    const props={executionId:id,assignmentId:id,versionId:id,revision:3,current:{status:'in_progress' as const,actualResult:'Original',comments:'',defectNotes:'',improvementNotes:''}};
    const view=wrap(<TestingObservationForm {...props}/>);
    fireEvent.change(screen.getByLabelText(en.systemTestingWorkspace.actualResult),{target:{value:'Unsubmitted typed observation'}});
    view.rerender(<NextIntlClientProvider locale="en" messages={en}><TestingObservationForm {...props} revision={4} current={{...props.current,actualResult:'Changed in another tab'}}/></NextIntlClientProvider>);
    expect(screen.getByLabelText(en.systemTestingWorkspace.actualResult)).toHaveValue('Unsubmitted typed observation');
    expect((document.querySelector('input[name="revision"]') as HTMLInputElement).value).toBe('3');
  });
  it('retains its submitted status and text after an actual successful action reset, then submits the acknowledged revision',async()=>{
    const submissions:Record<string,string>[]=[];
    actions.observe.mockImplementation(async(_prior,form:FormData)=>{
      submissions.push(Object.fromEntries([...form].map(([key,value])=>[key,String(value)])));
      return {error:null,savedObservation:{executionId:id,revision:submissions.length+3}};
    });
    wrap(<TestingObservationForm executionId={id} assignmentId={id} versionId={id} revision={3} current={{status:'failed',actualResult:'Prior failed result',comments:'Prior comment',defectNotes:'Prior defect',improvementNotes:'Prior improvement'}}/>);
    fireEvent.change(screen.getByLabelText(en.systemTestingWorkspace.status),{target:{value:'passed'}});
    for(const [label,value]of [[en.systemTestingWorkspace.actualResult,'Observed passing result'],[en.systemTestingWorkspace.comments,'New comment'],[en.systemTestingWorkspace.defectNotes,''],[en.systemTestingWorkspace.improvementNotes,'New improvement']])fireEvent.change(screen.getByLabelText(label),{target:{value}});
    fireEvent.submit(screen.getByRole('button',{name:en.systemTestingWorkspace.saveObservation}).closest('form')!);
    await waitFor(()=>expect((document.querySelector('input[name="revision"]') as HTMLInputElement).value).toBe('4'));
    expect(screen.getByLabelText(en.systemTestingWorkspace.status)).toHaveValue('passed');
    expect(screen.getByLabelText(en.systemTestingWorkspace.actualResult)).toHaveValue('Observed passing result');
    expect(screen.getByLabelText(en.systemTestingWorkspace.comments)).toHaveValue('New comment');
    expect(screen.getByLabelText(en.systemTestingWorkspace.defectNotes)).toHaveValue('');
    expect(screen.getByLabelText(en.systemTestingWorkspace.improvementNotes)).toHaveValue('New improvement');
    fireEvent.submit(screen.getByRole('button',{name:en.systemTestingWorkspace.saveObservation}).closest('form')!);
    await waitFor(()=>expect((document.querySelector('input[name="revision"]') as HTMLInputElement).value).toBe('5'));
    expect(submissions).toHaveLength(2);
    expect(submissions[0]).toMatchObject({revision:'3',status:'passed',actualResult:'Observed passing result',defectNotes:''});
    expect(submissions[1]).toMatchObject({revision:'4',status:'passed',actualResult:'Observed passing result',comments:'New comment',defectNotes:'',improvementNotes:'New improvement'});
  });
  it('preserves edits and the last own acknowledged revision after a refused action',async()=>{
    const submissions:Record<string,string>[]=[];
    actions.observe.mockImplementation(async(_prior,form:FormData)=>{
      submissions.push(Object.fromEntries([...form].map(([key,value])=>[key,String(value)])));
      return submissions.length===1?{error:null,savedObservation:{executionId:id,revision:4}}:{error:'invalid'};
    });
    wrap(<TestingObservationForm executionId={id} assignmentId={id} versionId={id} revision={3} current={{status:'failed',actualResult:'Original',comments:'',defectNotes:'Old defect',improvementNotes:''}}/>);
    fireEvent.submit(screen.getByRole('button',{name:en.systemTestingWorkspace.saveObservation}).closest('form')!);
    await waitFor(()=>expect((document.querySelector('input[name="revision"]') as HTMLInputElement).value).toBe('4'));
    fireEvent.change(screen.getByLabelText(en.systemTestingWorkspace.status),{target:{value:'passed'}});
    fireEvent.change(screen.getByLabelText(en.systemTestingWorkspace.actualResult),{target:{value:'Keep unsaved result'}});
    fireEvent.change(screen.getByLabelText(en.systemTestingWorkspace.defectNotes),{target:{value:''}});
    fireEvent.submit(screen.getByRole('button',{name:en.systemTestingWorkspace.saveObservation}).closest('form')!);
    await screen.findByRole('alert');
    expect(screen.getByLabelText(en.systemTestingWorkspace.status)).toHaveValue('passed');
    expect(screen.getByLabelText(en.systemTestingWorkspace.actualResult)).toHaveValue('Keep unsaved result');
    expect(screen.getByLabelText(en.systemTestingWorkspace.defectNotes)).toHaveValue('');
    expect((document.querySelector('input[name="revision"]') as HTMLInputElement).value).toBe('4');
    expect(submissions[1]).toMatchObject({revision:'4',status:'passed',actualResult:'Keep unsaved result',defectNotes:''});
  });
  it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders all result states and explanatory copy in %s',locale=>{
    wrap(<TestingObservationForm executionId={id} assignmentId={id} versionId={id} revision={3} current={{status:'blocked',actualResult:'Fictional result',comments:'',defectNotes:'',improvementNotes:''}}/>,locale);
    const words=catalogues[locale].systemTestingWorkspace,select=screen.getByLabelText(words.status);
    expect(within(select).getByRole('option',{name:words.statuses.retest_required})).toBeTruthy();
    expect(within(select).getByRole('option',{name:words.statuses.not_applicable})).toBeTruthy();
    expect(screen.getByText(words.observationNote)).toBeTruthy();expect(screen.getByLabelText(words.actualResult)).toHaveValue('Fictional result');
    expect((document.querySelector('input[name="revision"]') as HTMLInputElement).value).toBe('3');
    expect(actions.observe).not.toHaveBeenCalled();
  });
});
