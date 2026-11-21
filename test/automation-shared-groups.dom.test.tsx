import {beforeEach,describe,expect,it,vi} from 'vitest';
import {render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {AssignmentGroups} from '../app/automation/groups/assignment-groups';
import type {AutomationGroupWorkspace} from '../core/automation-groups';
const mocks=vi.hoisted(()=>({save:vi.fn(),search:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh})}));
vi.mock('../app/automation/actions',()=>({saveAssignmentGroupsAction:mocks.save,searchAssignmentGroupPeopleAction:mocks.search,searchPeopleAction:mocks.search}));
const userId='11111111-1111-4111-8111-111111111111';
const initial:AutomationGroupWorkspace={revision:4,v9Revision:1,groups:[{id:'retained',name:'Fictional reviewers',members:[userId],limit:20}],people:[{id:userId,name:'Fictional reviewer'}]};
beforeEach(()=>{vi.clearAllMocks();});
const show=()=>render(<NextIntlClientProvider locale="en" messages={messages}><AssignmentGroups initial={initial} usedBy={{retained:['Workflow: Renewal']}}/></NextIntlClientProvider>);
describe('Shared assignment group editor',()=>{
 it('retains saved memberships and group identities while allowing an unsaved new group to be discarded',async()=>{
  show();expect(screen.queryByRole('button',{name:/Remove Fictional reviewer/})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:/Delete group/})).not.toBeInTheDocument();
  expect(screen.getByText(/Existing memberships are retained here/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button',{name:'New group'}));expect(screen.getByRole('button',{name:'Discard new group'})).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button',{name:'Discard new group'}));expect(screen.getByLabelText('Group name')).toHaveValue('Fictional reviewers');
 });
 it('keeps edits after a save failure and sends only groups with the native revision checks',async()=>{
  mocks.save.mockRejectedValueOnce(new Error('Network unavailable'));show();
  await userEvent.clear(screen.getByLabelText('Group name'));await userEvent.type(screen.getByLabelText('Group name'),'Updated fictional reviewers');
  await userEvent.click(screen.getByRole('button',{name:'Save assignment groups'}));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Your changes are kept here'));
  expect(screen.getByLabelText('Group name')).toHaveValue('Updated fictional reviewers');
  expect(mocks.save).toHaveBeenCalledWith({revision:4,v9Revision:1,groups:[{...initial.groups[0],name:'Updated fictional reviewers'}],reason:expect.any(String)});
  expect(mocks.save.mock.calls[0][0]).not.toHaveProperty('access');expect(mocks.refresh).not.toHaveBeenCalled();
 });
});
