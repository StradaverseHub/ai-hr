/** ADR-0169 §5.1 wiring — the live chat command routes on the tenant's Noveri conversation switch. Owners are
 * stubbed: askAssistant's own gates are proved by its suites, the turn by test/teras-conversation-turn.test.ts and
 * the switch by test/teras-conversation-switch.test.ts. Fictional values only.
 *
 * Switch off: the closed grammar is called with exactly the arguments it received before wiring, and its reply
 * is returned unchanged; no harness module runs. Switch on: the turn runs and the closed grammar is never called. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const owner=vi.hoisted(()=>({session:vi.fn(),ask:vi.fn(),workspace:vi.fn(),reply:vi.fn(),route:vi.fn(),turn:vi.fn(),render:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async(namespace:string)=>Object.assign((key:string)=>`${namespace}.${key}`,{has:(key:string)=>key.startsWith('err_')||key.startsWith('errors.')})}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:owner.session}));
vi.mock('../core/assistant',()=>({askAssistant:owner.ask,AssistantError:class extends Error{constructor(readonly code:string){super(code);}}}));
vi.mock('../core/ai-workspace',()=>({loadAiWorkspace:owner.workspace}));
vi.mock('../core/assistant-threads',()=>({loadOwnAssistantChat:vi.fn(),listOwnAssistantChats:vi.fn()}));
vi.mock('../components/assistant/exchange-reply',()=>({ExchangeReply:owner.reply}));
vi.mock('../core/read',()=>({allowedCompanies:async()=>[{id:'00000000-0000-4000-8000-00000000c0aa'}]}));
vi.mock('../lib/scope',()=>({getScopeIds:async(ids:string[])=>ids}));
vi.mock('../core/teras-wiring/switch',()=>({conversationRoute:owner.route}));
vi.mock('../core/teras-wiring/turn',()=>({runConversationTurn:owner.turn,ConversationTurnError:class extends Error{constructor(readonly code:string){super(code);}}}));
vi.mock('../components/ai-centre/conversation-reply',()=>({ConversationReply:owner.render}));
import {askFromLauncherAction,askFromWorkspaceAction} from '../app/assistant/launcher-actions';

const session={tenantId:'00000000-0000-4000-8000-0000000000aa',userId:'00000000-0000-4000-8000-0000000000bb'};
const SCOPE=JSON.stringify(['00000000-0000-4000-8000-00000000c0aa']);
const permit=Object.freeze({});
beforeEach(()=>{
 for(const fn of Object.values(owner))fn.mockReset();
 owner.session.mockResolvedValue(session);
 owner.ask.mockResolvedValue({exchangeId:'closed-1',conversationToken:'closed-proof'});
 owner.workspace.mockResolvedValue({history:[{id:'closed-1',grounded:null}]});
 owner.reply.mockResolvedValue('closed grammar reply');
 owner.turn.mockResolvedValue({turnId:'turn-1',continuation:'tc1.model-side.signature'});
 owner.render.mockResolvedValue('harness reply');
});

describe('switch off: the closed grammar, unchanged',()=>{
 it('calls askAssistant with exactly the pre-wiring arguments and returns its reply; the turn never runs',async()=>{
  owner.route.mockResolvedValue({route:'closed'});
  const cases=[
   [{question:'  How much leave do I have?  ',path:'/leave'},{question:'How much leave do I have?',conversationScope:SCOPE}],
   [{question:'And pending?',path:'/assistant',previousExchangeId:'closed-0',previousConversationToken:'proof'},{question:'And pending?',conversationScope:SCOPE,previousExchangeId:'closed-0',previousConversationToken:'proof'}],
   [{question:'Annual',path:'/assistant',clarificationExchangeId:'closed-0'},{question:'Annual',conversationScope:SCOPE,clarificationExchangeId:'closed-0'}],
  ] as const;
  for(const [input,expected] of cases){
   owner.ask.mockClear();
   expect(await askFromLauncherAction(input)).toEqual({ok:true,exchangeId:'closed-1',conversationToken:'closed-proof',answer:'closed grammar reply'});
   expect(owner.ask).toHaveBeenCalledOnce();expect(owner.ask).toHaveBeenCalledWith(session,expected);
  }
  expect(owner.turn).not.toHaveBeenCalled();expect(owner.render).not.toHaveBeenCalled();
 });
 it('treats an unreadable switch as off',async()=>{
  owner.route.mockRejectedValue(Error('PRIVATE switch failure'));
  expect(await askFromWorkspaceAction({question:'Hi'})).toMatchObject({ok:true,exchangeId:'closed-1'});
  expect(owner.turn).not.toHaveBeenCalled();
 });
});

describe('switch on: the Teras harness',()=>{
 it('runs the turn with the switch permit, the company scope and the model-side continuation; never the closed grammar',async()=>{
  owner.route.mockResolvedValue({route:'harness',permit,attestedProvider:null,explainers:false});
  expect(await askFromWorkspaceAction({question:' How much leave do I have? '})).toEqual({ok:true,exchangeId:'teras-turn-1',answer:'harness reply',conversationToken:'tc1.model-side.signature'});
  expect(owner.turn).toHaveBeenCalledWith(session,{route:'harness',permit,attestedProvider:null,explainers:false},{question:'How much leave do I have?',companyId:'00000000-0000-4000-8000-00000000c0aa',locale:'en'});
  await askFromWorkspaceAction({question:'And next month?',previousExchangeId:'teras-turn-1',previousConversationToken:'tc1.model-side.signature'});
  expect(owner.turn.mock.calls[1][2]).toMatchObject({continuation:'tc1.model-side.signature'});
  expect(owner.ask).not.toHaveBeenCalled();expect(owner.workspace).not.toHaveBeenCalled();
 });
 it('shows a closed, translated refusal for every turn error and never the provider detail',async()=>{
  owner.route.mockResolvedValue({route:'harness',permit,attestedProvider:null,explainers:false});
  const {ConversationTurnError}=await import('../core/teras-wiring/turn');
  owner.turn.mockRejectedValueOnce(new (ConversationTurnError as unknown as new(code:string)=>Error)('provider_not_compliant'));
  expect(await askFromWorkspaceAction({question:'Hi'})).toEqual({ok:false,message:'aiCentre.conversation.errors.provider_not_compliant'});
  owner.turn.mockRejectedValueOnce(Error('PRIVATE provider body'));
  expect(await askFromWorkspaceAction({question:'Hi'})).toEqual({ok:false,message:'aiCentre.conversation.errors.provider_error'});
  // A closed-grammar clarification cannot continue a harness conversation.
  expect(await askFromLauncherAction({question:'Annual',path:'/assistant',clarificationExchangeId:'closed-0'})).toEqual({ok:false,message:'aiCentre.conversation.errors.continuation_invalid'});
  expect(owner.ask).not.toHaveBeenCalled();
 });
});
