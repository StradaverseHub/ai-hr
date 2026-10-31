/** @vitest-environment jsdom */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
const state=vi.hoisted(()=>({ask:vi.fn(),earlier:vi.fn(),more:vi.fn()}));
vi.mock('../app/assistant/launcher-actions',()=>({askFromWorkspaceAction:state.ask,loadEarlierChatAction:state.earlier,loadMoreChatsAction:state.more}));
import {ConversationSuggestions,ConversationClarification} from '../components/assistant/chat-reply-boundary';
import {SavedChatList} from '../components/assistant/saved-chat-list';
import {WorkspaceConversation} from '../components/assistant/workspace-conversation';
const copy=en.assistant,chat=copy.workspace.chat;
function show(initialTurn?:{id:string;question:string;answer:React.ReactNode;clarificationRequired?:boolean},fullHeight=false){return render(<NextIntlClientProvider locale="en" messages={en}><WorkspaceConversation tasks={[]} fileImport={false} initialTurn={initialTurn} fullHeight={fullHeight}/></NextIntlClientProvider>);}
function send(question:string){fireEvent.change(screen.getByLabelText(copy.workspace.question),{target:{value:question}});fireEvent.click(screen.getByRole('button',{name:copy.ask}));}
beforeEach(()=>{state.ask.mockReset();state.earlier.mockReset();});afterEach(cleanup);
describe('in-place Assistant conversation',()=>{
 it('keeps the selected conversation mounted through pending and a fresh scoped sidebar update',async()=>{
  let finish!:(value:unknown)=>void;state.ask.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const threadId='72000000-0000-4000-8000-000000000001',exchangeId='72000000-0000-4000-8000-000000000002',scopeDigest='a'.repeat(64);
  render(<NextIntlClientProvider locale="en" messages={en}><SavedChatList initialChats={[]} nextCursor={null} scopeDigest={scopeDigest} newChatHref="/assistant?chatReset=stable"/><WorkspaceConversation tasks={[]} fileImport={false} fullHeight historyTailId={threadId} initialTurns={[{id:threadId,question:'Retained question',answer:<p>Retained canonical answer</p>}]} initialResume={{exchangeId:threadId,conversationToken:'selected-owned-proof'}}/></NextIntlClientProvider>);
  const transcript=screen.getByRole('log');send('Thanks');expect(screen.getByRole('log')).toBe(transcript);expect(transcript).toHaveTextContent('Retained canonical answer');expect(transcript).toHaveTextContent('Thinking');expect(screen.getByRole('button',{name:copy.workspace.working})).toBeDisabled();
  await act(async()=>finish({ok:true,exchangeId,conversationToken:'next-proof',answer:<p>New canonical answer</p>,chatList:{chats:[{threadId,exchangeId,title:'Current thread summary'}],nextCursor:null,scopeDigest}}));
  expect(screen.getByRole('log')).toBe(transcript);expect(transcript).toHaveTextContent('Retained canonical answer');expect(transcript).toHaveTextContent('New canonical answer');expect(screen.getByRole('link',{name:'Current thread summary'})).toHaveAttribute('href','/assistant?e='+exchangeId);expect(state.ask).toHaveBeenCalledExactlyOnceWith({question:'Thanks',previousExchangeId:threadId,previousConversationToken:'selected-owned-proof'});
 });

 it('a generic suggested task leaves a pending clarification target without submitting immediately',async()=>{
  show({id:'checked',question:'Earlier checked question',answer:<ConversationSuggestions label="Next" suggestions={[{label:'Upcoming holidays',prompt:'When is the next public holiday?'}]}/>});
  state.ask.mockResolvedValueOnce({ok:true,exchangeId:'clarify',conversationToken:'clarify-proof',clarificationRequired:true,answer:<p>Which leave type?</p>});send('My leave');await screen.findByText('Which leave type?');
  fireEvent.click(screen.getByRole('button',{name:'Upcoming holidays'}));expect(state.ask).toHaveBeenCalledTimes(1);expect(screen.getByRole('textbox')).toHaveValue('When is the next public holiday?');
  state.ask.mockResolvedValueOnce({ok:true,exchangeId:'holiday',conversationToken:'holiday-proof',answer:<p>Checked holiday answer</p>});fireEvent.click(screen.getByRole('button',{name:copy.ask}));await screen.findByText('Checked holiday answer');
  expect(state.ask).toHaveBeenLastCalledWith({question:'When is the next public holiday?',previousExchangeId:'clarify',previousConversationToken:'clarify-proof'});
 });
 it('allows explicit New chat from an unavailable selection with no restored turns',async()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><WorkspaceConversation tasks={[]} fileImport={false} fullHeight historyTailId="missing" historyReadOnly/></NextIntlClientProvider>);
  expect(screen.getByRole('button',{name:copy.ask})).toBeDisabled();expect(screen.getByRole('button',{name:chat.new})).toBeEnabled();fireEvent.click(screen.getByRole('button',{name:chat.new}));state.ask.mockResolvedValueOnce({ok:true,exchangeId:'fresh',conversationToken:'fresh-proof',answer:<p>Fresh answer</p>});send('Hello');await screen.findByText('Fresh answer');expect(state.ask).toHaveBeenLastCalledWith({question:'Hello'});
 });

 it('restores more than six displayed turns while continuing only with the owner-issued selected tail proof',async()=>{
  const turns=Array.from({length:9},(_,index)=>({id:'saved-'+index,question:'Saved question '+index,answer:<p>Checked answer {index}</p>}));
  render(<NextIntlClientProvider locale="en" messages={en}><WorkspaceConversation tasks={[]} fileImport={false} fullHeight initialTurns={turns} historyTailId="saved-8" initialResume={{exchangeId:'saved-8',conversationToken:'owned-tail-proof'}}/></NextIntlClientProvider>);
  expect(screen.getByRole('log')).toHaveTextContent('Saved question 0');expect(screen.getByRole('log')).toHaveTextContent('Saved question 8');
  state.ask.mockResolvedValueOnce({ok:true,exchangeId:'new',answer:<p>New checked answer</p>});send('And pending?');await screen.findByText('New checked answer');
  expect(state.ask).toHaveBeenLastCalledWith({question:'And pending?',previousExchangeId:'saved-8',previousConversationToken:'owned-tail-proof'});
 });
 it('keeps legacy or uncertain saved history read-only until the person explicitly starts New chat',async()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><WorkspaceConversation tasks={[]} fileImport={false} fullHeight historyTailId="legacy" initialTurns={[{id:'legacy',question:'Old question',answer:<button>Prepare old action</button>}]} historyReadOnly/></NextIntlClientProvider>);
  expect(screen.getByRole('button',{name:copy.ask})).toBeDisabled();expect(screen.getByRole('button',{name:'Prepare old action'})).toBeDisabled();expect(state.ask).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:chat.new}));state.ask.mockResolvedValueOnce({ok:true,exchangeId:'fresh',answer:<p>Fresh reply</p>});send('Hello');await screen.findByText('Fresh reply');expect(state.ask).toHaveBeenLastCalledWith({question:'Hello'});expect(screen.queryByText('Old question')).toBeNull();
 });
 it('prepends a selected-branch earlier page without replacing the live tail continuation',async()=>{
  state.earlier.mockResolvedValueOnce({ok:true,turns:[{id:'earlier',question:'Earlier question',answer:<p>Earlier checked reply</p>}],olderCursor:null});
  render(<NextIntlClientProvider locale="en" messages={en}><WorkspaceConversation tasks={[]} fileImport={false} fullHeight historyTailId="tail" olderCursor="sealed-earlier" initialTurns={[{id:'tail',question:'Latest question',answer:<p>Latest checked reply</p>}]} initialResume={{exchangeId:'tail',conversationToken:'tail-proof'}}/></NextIntlClientProvider>);
  fireEvent.click(screen.getByRole('button',{name:chat.older}));await screen.findByText('Earlier checked reply');expect(state.earlier).toHaveBeenCalledExactlyOnceWith({exchangeId:'tail',before:'sealed-earlier'});
  expect(screen.getByText('Earlier question').compareDocumentPosition(screen.getByText('Latest question'))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  state.ask.mockResolvedValueOnce({ok:true,exchangeId:'next',answer:<p>Continued reply</p>});send('Continue');await screen.findByText('Continued reply');expect(state.ask).toHaveBeenLastCalledWith({question:'Continue',previousExchangeId:'tail',previousConversationToken:'tail-proof'});
 });

 it('starts the full workspace with a transcript and one anchored composer before the first question',()=>{
  show(undefined,true);expect(screen.getByRole('log')).toBeInTheDocument();expect(screen.getAllByRole('textbox')).toHaveLength(1);
  expect(screen.getByRole('region',{name:chat.title}).className).toContain('flex-col');expect(screen.getByRole('log').className).toContain('flex-1');
  expect(state.ask).not.toHaveBeenCalled();
 });
 it('routes the next normal composer turn to a canonical clarification and then resumes ordinary context',async()=>{
  state.ask.mockResolvedValueOnce({ok:true,exchangeId:'owned-choice',conversationToken:'choice-token',clarificationRequired:true,answer:<p>Which leave type?</p>});show();send('My leave balance');await screen.findByText('Which leave type?');
  state.ask.mockResolvedValueOnce({ok:true,exchangeId:'answer',conversationToken:'answer-token',answer:<p>Annual balance: 12 days</p>});send('Annual leave');await screen.findByText('Annual balance: 12 days');
  expect(state.ask).toHaveBeenLastCalledWith({question:'Annual leave',clarificationExchangeId:'owned-choice'});
  state.ask.mockResolvedValueOnce({ok:true,exchangeId:'followup',answer:<p>Pending: 2 days</p>});send('And pending?');await screen.findByText('Pending: 2 days');
  expect(state.ask).toHaveBeenLastCalledWith({question:'And pending?',previousExchangeId:'answer',previousConversationToken:'answer-token'});
  expect(screen.getAllByRole('textbox')).toHaveLength(1);
 });

 it('captures the real in-place conversation at its actual page reading width',async()=>{
  const view=show({id:'fictional-checked',question:'How much leave do I have?',answer:<p>Annual leave: 12 days</p>});
  await captureAiReviewScreenshots('<div class="mx-auto max-w-3xl">'+aiReviewDomHtml(view.container)+'</div>','en','overview','Real in-place conversation component; fictional authorized-command response; no authenticated server/provider journey');
 },30_000);

 it('drops erased local content and ignores a response finishing after privacy reset or another history selection',async()=>{
  let resolve!:(value:unknown)=>void;state.ask.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));const view=show();send('Private pending question');
  view.rerender(<NextIntlClientProvider locale="en" messages={en}><WorkspaceConversation tasks={[]} fileImport={false} resetKey="successful-erase-1"/></NextIntlClientProvider>);
  expect(screen.queryByText('Private pending question')).toBeNull();
  await act(async()=>resolve({ok:true,exchangeId:'erased',conversationToken:'erased-token',answer:<p>Erased reply</p>}));expect(screen.queryByText('Erased reply')).toBeNull();
  state.ask.mockResolvedValueOnce({ok:true,exchangeId:'new',conversationToken:'new-proof',answer:<p>New reply</p>});send('New question');await screen.findByText('New reply');expect(state.ask).toHaveBeenLastCalledWith({question:'New question'});
  state.ask.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));send('Pending old selection');
  view.rerender(<NextIntlClientProvider locale="en" messages={en}><WorkspaceConversation tasks={[]} fileImport={false} resetKey="successful-erase-1" initialTurn={{id:'selected',question:'Selected question',answer:<p>Selected reply</p>}}/></NextIntlClientProvider>);
  await act(async()=>resolve({ok:true,exchangeId:'old',conversationToken:'old-token',answer:<p>Late old answer</p>}));expect(screen.queryByText('Late old answer')).toBeNull();expect(screen.getByText('Selected reply')).toBeInTheDocument();
  state.ask.mockResolvedValueOnce({ok:true,exchangeId:'next',answer:<p>Next reply</p>});send('Next question');await screen.findByText('Next reply');expect(state.ask).toHaveBeenLastCalledWith({question:'Next question'});
 });
 it('submits a clarification in place through its dedicated owned-exchange path',async()=>{
  state.ask.mockResolvedValueOnce({ok:true,exchangeId:'answered',conversationToken:'answered-proof',answer:<p>Annual balance: 12 days</p>});
  show({id:'needs-clarification',question:'How much leave?',clarificationRequired:true,answer:<ConversationClarification exchangeId="needs-clarification" replyLabel="Your reply" continueLabel="Continue"/>});
  send('Annual leave');
  await screen.findByText('Annual balance: 12 days');expect(screen.getByText('How much leave?')).toBeInTheDocument();expect(state.ask).toHaveBeenCalledWith({question:'Annual leave',clarificationExchangeId:'needs-clarification'});expect(window.location.search).toBe('');
 });
 it('shows the question and waiting reply immediately, keeps earlier replies and passes the opaque continuation only after success',async()=>{
  let resolve!:(value:unknown)=>void;state.ask.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));show();
  send('How much leave do I have?');
  expect(screen.getByRole('log')).toHaveTextContent('How much leave do I have?');expect(screen.getByRole('region',{name:chat.title}).className).toContain('flex-col');expect(screen.getByRole('log').className).toContain('flex-1');expect(screen.getByRole('log')).toHaveTextContent(chat.thinking);
  expect(screen.getByRole('button',{name:copy.workspace.working})).toBeDisabled();expect(state.ask).toHaveBeenCalledTimes(1);
  expect(state.ask).toHaveBeenCalledWith({question:'How much leave do I have?'});
  await act(async()=>resolve({ok:true,exchangeId:'exchange-1',conversationToken:'opaque-1',answer:<p>Annual leave: 12 days</p>}));
  state.ask.mockResolvedValueOnce({ok:true,exchangeId:'exchange-2',conversationToken:'opaque-2',answer:<p>Pending leave: 2 days</p>});send('And how much is pending?');
  await waitFor(()=>expect(screen.getByText('Pending leave: 2 days')).toBeInTheDocument());
  expect(screen.getByText('Annual leave: 12 days')).toBeInTheDocument();expect(state.ask).toHaveBeenLastCalledWith({question:'And how much is pending?',previousExchangeId:'exchange-1',previousConversationToken:'opaque-1'});
  expect(window.location.search).toBe('');expect(screen.queryByText('Check current facts')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:chat.new}));expect(screen.queryByText('Annual leave: 12 days')).toBeNull();
  state.ask.mockResolvedValueOnce({ok:false,message:'Please try again.'});send('Start again');await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Please try again.'));
  expect(state.ask).toHaveBeenLastCalledWith({question:'Start again'});
 });
 it('preserves a reader scrolling upward when a delayed answer arrives and provides an explicit latest-reply control',async()=>{
  let resolve!:(value:unknown)=>void;state.ask.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));show({id:'saved',question:'Earlier question',answer:<p>Earlier answer</p>});
  send('Another question');const log=screen.getByRole('log');Object.defineProperties(log,{scrollHeight:{value:1200,configurable:true},clientHeight:{value:300,configurable:true}});log.scrollTop=100;fireEvent.scroll(log);
  await act(async()=>resolve({ok:true,exchangeId:'next',answer:<p>New answer</p>}));expect(log.scrollTop).toBe(100);
  fireEvent.click(screen.getByRole('button',{name:chat.latest}));expect(log.scrollTop).toBe(1200);
  // Reopening old history never fabricates a scope proof for that old question.
  expect(state.ask).toHaveBeenCalledWith({question:'Another question'});
 });
 it('follows replies near the bottom, preserves failures inline and never continues using an uncertain parent',async()=>{
  state.ask.mockResolvedValueOnce({ok:true,exchangeId:'one',conversationToken:'token',answer:<p>First answer</p>});show();send('First');await screen.findByText('First answer');
  let reject!:(reason:unknown)=>void;state.ask.mockImplementationOnce(()=>new Promise((_done,fail)=>{reject=fail;}));send('Second');const log=screen.getByRole('log');Object.defineProperties(log,{scrollHeight:{value:900,configurable:true},clientHeight:{value:300,configurable:true}});log.scrollTop=590;fireEvent.scroll(log);
  await act(async()=>reject(Error('PRIVATE provider data')));expect(log.scrollTop).toBe(900);expect(screen.getByRole('alert')).toHaveTextContent(copy.err_provider_error);expect(screen.queryByText('PRIVATE provider data')).toBeNull();
  expect(screen.getByRole('button',{name:copy.ask})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:chat.new}));state.ask.mockResolvedValueOnce({ok:true,exchangeId:'three',answer:<p>Third answer</p>});send('Third');await screen.findByText('Third answer');expect(state.ask).toHaveBeenLastCalledWith({question:'Third'});
 });
});
