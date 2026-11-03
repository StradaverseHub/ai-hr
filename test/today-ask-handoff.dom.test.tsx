/** AI v2 Phase 1, W3 — the AI Centre Ask side of Today's Ask bar: the handed-over question is sent once, through the
 * same conversation command as a typed one, and only where the Ask page opted in. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const state=vi.hoisted(()=>({ask:vi.fn(),earlier:vi.fn()}));
vi.mock('../app/assistant/launcher-actions',()=>({askFromWorkspaceAction:state.ask,loadEarlierChatAction:state.earlier}));
import {WorkspaceConversation} from '../components/assistant/workspace-conversation';
import {ASK_HANDOFF_KEY,storeAskHandoff} from '../lib/today/ask-handoff';

const show=(acceptHandoff:boolean)=>render(<NextIntlClientProvider locale="en" messages={en}><WorkspaceConversation tasks={[]} fileImport={false} fullHeight acceptHandoff={acceptHandoff}/></NextIntlClientProvider>);
beforeEach(()=>{state.ask.mockReset();state.earlier.mockReset();window.sessionStorage.clear();window.history.replaceState(null,'','/assistant');});
afterEach(()=>{cleanup();window.history.replaceState(null,'','/');});

describe('Ask accepts the question typed on Today',()=>{
 it('sends it once as the person\'s question and removes it',async()=>{
  storeAskHandoff(window.sessionStorage,'How much annual leave do I have?');
  state.ask.mockResolvedValueOnce({ok:true,exchangeId:'handed',conversationToken:'proof',answer:<p>Fictional answer</p>});
  show(true);
  await screen.findByText('Fictional answer');
  expect(state.ask).toHaveBeenCalledTimes(1);
  expect(state.ask).toHaveBeenCalledWith({question:'How much annual leave do I have?'});
  expect(window.sessionStorage.getItem(ASK_HANDOFF_KEY)).toBeNull();
  expect(screen.getByRole('log')).toHaveTextContent('How much annual leave do I have?');
 });

 it('sends nothing where the page did not opt in, nor on another view, nor without a handoff',async()=>{
  storeAskHandoff(window.sessionStorage,'Kept for the Ask page');
  show(false);
  expect(state.ask).not.toHaveBeenCalled();
  expect(window.sessionStorage.getItem(ASK_HANDOFF_KEY)).not.toBeNull();
  cleanup();
  window.history.replaceState(null,'','/assistant?view=inbox');
  show(true);
  expect(state.ask).not.toHaveBeenCalled();
  // Read once and dropped: it will not be sent later by another page either.
  expect(window.sessionStorage.getItem(ASK_HANDOFF_KEY)).toBeNull();
  cleanup();
  window.history.replaceState(null,'','/assistant');
  show(true);
  expect(state.ask).not.toHaveBeenCalled();
 });
});
