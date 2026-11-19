import {expect,it,vi} from 'vitest';
import {fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {WorkflowsWorkspace,type ListedWorkflow} from '../app/automation/workflows/workflows-workspace';
import type {WorkflowEditorReferences} from '../app/automation/workflows/workflow-editor';

vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/automation/actions',()=>({installProbationDefaultsAction:vi.fn(),installOffboardingDefaultsAction:vi.fn(),moveProbationWorkflowsAction:vi.fn()}));
vi.mock('../app/automation/workflows/workflow-editor',()=>({WorkflowEditor:({initial,revision,editable,onClose}:{initial:{name:string};revision:number;editable:boolean;onClose:()=>void})=><section aria-label="Selected workflow"><h1>{initial.name}</h1><p>Revision {revision}</p><p>{editable?'Editable':'Read only'}</p><button onClick={onClose}>Close editor</button></section>}));
const item:ListedWorkflow={revision:4,workflow:{id:'selected-offboarding',module:'off',name:'Resignation accepted',description:'',required:false,status:'live',trigger:{event:'accepted',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[]}};
const refs:WorkflowEditorReferences={routings:[],groups:[],people:[],emailTemplates:[],letterTemplates:[],conditionValues:{}};
const show=(selected:string,editable=true)=>render(<NextIntlClientProvider locale="en" messages={messages}><WorkflowsWorkspace filter="off" access={{legacy:true,probation:false,contractStaff:false,any:true}} workflows={[]} refs={refs} defaultsMissing={0} offboarding={{workflows:[item],refs,editable}} initialOffboardingWorkflowId={selected}/></NextIntlClientProvider>);

it('opens the selected authorized shared workflow and returns to its list',()=>{
 show(item.workflow.id);
 expect(screen.getByRole('heading',{name:'Resignation accepted'})).toBeInTheDocument();
 expect(screen.getByText('Revision 4')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Close editor'}));
 expect(screen.queryByRole('region',{name:'Selected workflow'})).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Edit Resignation accepted'})).toBeInTheDocument();
});
it('does not turn a deep link into workflow edit authority',()=>{
 show(item.workflow.id,false);
 expect(screen.getByText('Read only')).toBeInTheDocument();
});
it('ignores a workflow ID outside the authorized Offboarding snapshot',()=>{
 show('unavailable-workflow');
 expect(screen.queryByRole('region',{name:'Selected workflow'})).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Edit Resignation accepted'})).toBeInTheDocument();
});
