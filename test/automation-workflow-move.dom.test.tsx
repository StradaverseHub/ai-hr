import {beforeEach,describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import type {WorkflowEditorReferences} from '../app/automation/workflows/workflow-editor';
import {WorkflowsWorkspace} from '../app/automation/workflows/workflows-workspace';
import type {AutomationPageAccess} from '../app/automation/types';

/** "Move to shared workflows" on HR Automation › Workflows (lane G2, migration 5757). The server action is mocked; its
 * authorization, idempotence and audit are covered by test/probation-legacy-conversion-db.test.ts. */
const m=vi.hoisted(()=>({move:vi.fn(),install:vi.fn(),save:vi.fn(),dryRun:vi.fn(),cases:vi.fn(),people:vi.fn(),refresh:vi.fn()}));
vi.mock('../app/automation/actions',()=>({moveProbationWorkflowsAction:m.move,installProbationDefaultsAction:m.install,saveWorkflowAction:m.save,dryRunWorkflowAction:m.dryRun,searchProbationCasesAction:m.cases,searchPeopleAction:m.people}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:m.refresh,push:vi.fn()})}));
vi.mock('next/link',async()=>{const React=await import('react');return {default:({prefetch:_prefetch,...props}:Record<string,unknown>)=>React.createElement('a',props,props.children as React.ReactNode)};});

const refs:WorkflowEditorReferences={routings:[],groups:[],people:[],emailTemplates:[],letterTemplates:[],
 conditionValues:{businessGroup:[],company:[],department:[],jobGrade:[],extensionsUsed:[]}};
const allowed:AutomationPageAccess={legacy:true,probation:true,contractStaff:false,any:true};
const show=(access:AutomationPageAccess,filter:'all'|'probation'='probation')=>render(<NextIntlClientProvider locale="en" messages={messages}><WorkflowsWorkspace filter={filter} access={access} workflows={[]} refs={refs} defaultsMissing={0}/></NextIntlClientProvider>);
const kept={definitionId:'00000000-0000-4000-8000-0000000000d2',name:'Review reminder',companyName:'Fictional Retail Sdn Bhd',reason:'Reminder schedules stay on the Probation builder until the shared engine sends them the same way.'};
const moved={definitionId:'00000000-0000-4000-8000-0000000000d1',workflowId:'00000000-0000-5000-8000-0000000000f1',name:'Outcome notice',companyName:'Fictional Retail Sdn Bhd'};
const reason=()=>screen.getByRole('textbox',{name:'Reason (kept in the audit history)'});
const button=()=>screen.getByRole('button',{name:'Move to shared workflows'});

beforeEach(()=>{vi.clearAllMocks();vi.spyOn(window,'confirm').mockReturnValue(true);});

describe('Move to shared workflows',()=>{
 it('is not offered without the Probation configure permission',()=>{
  show({legacy:true,probation:false,contractStaff:false,any:true});
  expect(screen.queryByText('Move Probation workflows to shared workflows')).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Move to shared workflows'})).not.toBeInTheDocument();
  expect(screen.getByText('You cannot configure Probation automation.')).toBeInTheDocument();
  show({legacy:true,probation:false,contractStaff:false,any:true},'all');
  expect(screen.queryByRole('button',{name:'Move to shared workflows'})).not.toBeInTheDocument();
 });

 it('needs a reason and a confirmation, then shows what moved and what stayed with the reason',async()=>{
  m.move.mockResolvedValue({ok:true,result:{moved:[moved],kept:[kept],alreadyMoved:0}});
  show(allowed);
  fireEvent.click(screen.getByText('Move Probation workflows to shared workflows'));
  expect(button()).toBeDisabled();
  fireEvent.change(reason(),{target:{value:'No'}});expect(button()).toBeDisabled();
  fireEvent.change(reason(),{target:{value:'Fictional cut-over to shared workflows'}});expect(button()).toBeEnabled();
  vi.mocked(window.confirm).mockReturnValueOnce(false);
  fireEvent.click(button());
  expect(m.move).not.toHaveBeenCalled();
  fireEvent.click(button());
  await screen.findByRole('region',{name:'Move result'});
  expect(m.move).toHaveBeenCalledExactlyOnceWith({reason:'Fictional cut-over to shared workflows'});
  expect(screen.getByText('Moved 1; 1 stay on the Probation builder; 0 were moved before.')).toHaveAttribute('role','status');
  const result=screen.getByRole('region',{name:'Move result'});
  expect(within(result).getByRole('heading',{name:'Moved'})).toBeInTheDocument();
  expect(within(result).getByText('Outcome notice · Fictional Retail Sdn Bhd')).toBeInTheDocument();
  expect(within(result).getByRole('heading',{name:'Staying on the Probation builder'})).toBeInTheDocument();
  expect(within(result).getByText('Review reminder · Fictional Retail Sdn Bhd')).toBeInTheDocument();
  expect(within(result).getByText(kept.reason)).toBeInTheDocument();
  expect(m.refresh).toHaveBeenCalledTimes(1);
  // The reason is not reused: a second move needs its own audit reason.
  expect(reason()).toHaveValue('');expect(button()).toBeDisabled();
 });

 it('moves nothing twice: a second click reports the earlier move and keeps listing what stays',async()=>{
  m.move.mockResolvedValueOnce({ok:true,result:{moved:[moved],kept:[kept],alreadyMoved:0}})
   .mockResolvedValueOnce({ok:true,result:{moved:[],kept:[kept],alreadyMoved:1}})
   .mockResolvedValueOnce({ok:true,result:{moved:[],kept:[],alreadyMoved:2}});
  show(allowed);
  fireEvent.click(screen.getByText('Move Probation workflows to shared workflows'));
  fireEvent.change(reason(),{target:{value:'First move'}});fireEvent.click(button());
  await screen.findByText('Moved 1; 1 stay on the Probation builder; 0 were moved before.');
  fireEvent.change(reason(),{target:{value:'Second move'}});fireEvent.click(button());
  await screen.findByText('Moved 0; 1 stay on the Probation builder; 1 were moved before.');
  let result=screen.getByRole('region',{name:'Move result'});
  expect(within(result).queryByRole('heading',{name:'Moved'})).not.toBeInTheDocument();
  expect(within(result).queryByText('Outcome notice · Fictional Retail Sdn Bhd')).not.toBeInTheDocument();
  expect(within(result).getByText(kept.reason)).toBeInTheDocument();
  fireEvent.change(reason(),{target:{value:'Third move'}});fireEvent.click(button());
  await screen.findByText('Moved 0; 0 stay on the Probation builder; 2 were moved before.');
  result=screen.getByRole('region',{name:'Move result'});
  expect(within(result).getByText('There was nothing left to move.')).toBeInTheDocument();
  expect(m.move.mock.calls.map(call=>call[0])).toEqual([{reason:'First move'},{reason:'Second move'},{reason:'Third move'}]);
 });

 it('shows the server refusal and no result',async()=>{
  m.move.mockResolvedValue({ok:false,detail:'You cannot configure this.'});
  show(allowed);
  fireEvent.click(screen.getByText('Move Probation workflows to shared workflows'));
  fireEvent.change(reason(),{target:{value:'Fictional attempt'}});fireEvent.click(button());
  expect(await screen.findByRole('alert')).toHaveTextContent('You cannot configure this.');
  expect(screen.queryByRole('region',{name:'Move result'})).not.toBeInTheDocument();
  await waitFor(()=>expect(m.refresh).not.toHaveBeenCalled());
  expect(reason()).toHaveValue('Fictional attempt');
 });
});
