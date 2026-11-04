/** ADR-0169 §5.1 wiring — the live chat command routes on the tenant's Noveri conversation switch. Owners are
 * stubbed: askAssistant's own gates are proved by its suites, the turn by test/teras-conversation-turn.test.ts,
 * the switch by test/teras-conversation-switch.test.ts and the chat store by test/teras-chats.test.ts. Fictional
 * values only.
 *
 * Switch off: the closed grammar is called with exactly the arguments it received before wiring, and its reply
 * is returned unchanged; no harness module runs. Switch on: the turn runs and the closed grammar is never called.
 * AI Centre issues 8 and 18: an answered harness turn is stored under its conversation (words withheld for a routed or
 * refused turn) and the reply names the stored chat, which Ask reopens and continues. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const owner=vi.hoisted(()=>({session:vi.fn(),ask:vi.fn(),workspace:vi.fn(),reply:vi.fn(),route:vi.fn(),turn:vi.fn(),render:vi.fn(),record:vi.fn(),reopen:vi.fn(),issue:vi.fn(),verify:vi.fn(),deleted:vi.fn()}));
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
vi.mock('../core/teras-chats',()=>({recordChatTurn:owner.record,reopenOwnChat:owner.reopen,isDeletedOwnChat:owner.deleted}));
vi.mock('../core/teras-wiring/history',()=>({issueConversationContinuation:owner.issue,verifyConversationContinuation:owner.verify}));
import {askFromLauncherAction,askFromWorkspaceAction,openStoredChatAction} from '../app/assistant/launcher-actions';

const session={tenantId:'00000000-0000-4000-8000-0000000000aa',userId:'00000000-0000-4000-8000-0000000000bb'};
const SCOPE=JSON.stringify(['00000000-0000-4000-8000-00000000c0aa']);
const permit=Object.freeze({});
const CHAT='00000000-0000-4000-8000-0000000c4a71';
const MODEL_TURN=[{role:'user',content:'How much leave do I have?',side:'model'},{role:'assistant',content:'You have [an earlier figure] days.',side:'model'}];
const harnessTurn=(over:Record<string,unknown>={})=>({turnId:'turn-1',continuation:'tc1.model-side.signature',reply:'You have 12 days.',modelTurn:MODEL_TURN,
 sensitive:false,refused:false,trace:{conversationId:CHAT},...over});
beforeEach(()=>{
 for(const fn of Object.values(owner))fn.mockReset();
 owner.session.mockResolvedValue(session);
 owner.ask.mockResolvedValue({exchangeId:'closed-1',conversationToken:'closed-proof'});
 owner.workspace.mockResolvedValue({history:[{id:'closed-1',grounded:null}]});
 owner.reply.mockResolvedValue('closed grammar reply');
 owner.turn.mockResolvedValue(harnessTurn());
 owner.render.mockResolvedValue('harness reply');
 owner.record.mockResolvedValue(CHAT);
 owner.verify.mockReturnValue({conversationId:CHAT,history:[]});
 owner.deleted.mockResolvedValue(false);
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
  expect(await askFromWorkspaceAction({question:' How much leave do I have? '})).toEqual({ok:true,exchangeId:'teras-turn-1',answer:'harness reply',conversationToken:'tc1.model-side.signature',chatId:CHAT});
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
 it('logs an unclassified failure by kind only, after the turn or while rendering, and stays silent for a classified one',async()=>{
  owner.route.mockResolvedValue({route:'harness',permit,attestedProvider:null,explainers:false});
  const logged=vi.spyOn(console,'error').mockImplementation(()=>{});
  try{
   class ContinuationRefused extends Error{constructor(){super('PRIVATE continuation detail');this.name='ContinuationRefused';}}
   owner.turn.mockRejectedValueOnce(new ContinuationRefused());
   expect(await askFromWorkspaceAction({question:'What can you help me with?'})).toEqual({ok:false,message:'aiCentre.conversation.errors.provider_error'});
   expect(logged).toHaveBeenLastCalledWith('[noveri conversation turn] unclassified failure',{name:'ContinuationRefused',code:null,supportId:expect.stringMatching(/^[0-9a-f-]{36}$/)});
   owner.render.mockRejectedValueOnce(Object.assign(Error('PRIVATE render detail'),{code:'22P02'}));
   expect(await askFromWorkspaceAction({question:'How much annual leave do I have?'})).toEqual({ok:false,message:'aiCentre.conversation.errors.provider_error'});
   expect(logged).toHaveBeenLastCalledWith('[noveri conversation turn] unclassified failure',{name:'Error',code:'22P02',supportId:expect.stringMatching(/^[0-9a-f-]{36}$/)});
   expect(JSON.stringify(logged.mock.calls)).not.toMatch(/PRIVATE|help me|annual leave/);
   const {ConversationTurnError}=await import('../core/teras-wiring/turn');
   logged.mockClear();owner.turn.mockRejectedValueOnce(new (ConversationTurnError as unknown as new(code:string)=>Error)('budget_daily'));
   expect(await askFromWorkspaceAction({question:'Hi'})).toEqual({ok:false,message:'aiCentre.conversation.errors.budget_daily'});
   expect(logged).not.toHaveBeenCalled();
  }finally{logged.mockRestore();}
 });
});

describe('stored chats (AI Centre issues 8 and 18)',()=>{
 const harness={route:'harness' as const,permit,attestedProvider:null,explainers:false};
 it('stores the answered turn under its conversation and scope, and names the stored chat in the reply',async()=>{
  owner.route.mockResolvedValue(harness);
  expect(await askFromLauncherAction({question:' How much leave do I have? ',path:'/leave'})).toMatchObject({ok:true,chatId:CHAT,conversationToken:'tc1.model-side.signature'});
  expect(owner.record).toHaveBeenCalledExactlyOnceWith(session,{conversationId:CHAT,conversationScope:SCOPE,companyId:'00000000-0000-4000-8000-00000000c0aa',
   question:'How much leave do I have?',reply:'You have 12 days.',modelRows:[{role:'user',content:'How much leave do I have?'},{role:'assistant',content:'You have [an earlier figure] days.'}],withheld:false});
 });
 it('a stale client continuing a chat its owner deleted starts a new conversation: the continuation is dropped',async()=>{
  owner.route.mockResolvedValue(harness);
  const NEW_CHAT='00000000-0000-4000-8000-0000000c4a72';
  owner.deleted.mockResolvedValueOnce(true);
  owner.turn.mockResolvedValueOnce(harnessTurn({trace:{conversationId:NEW_CHAT}}));owner.record.mockResolvedValueOnce(NEW_CHAT);
  expect(await askFromLauncherAction({question:'And next month?',path:'/leave',previousExchangeId:'teras-turn-1',previousConversationToken:'tc1.deleted-chat.signature'})).toMatchObject({ok:true,chatId:NEW_CHAT});
  expect(owner.verify).toHaveBeenCalledExactlyOnceWith(session,'tc1.deleted-chat.signature');
  expect(owner.deleted).toHaveBeenCalledExactlyOnceWith(session,CHAT);
  expect(owner.turn.mock.calls[0][2]).not.toHaveProperty('continuation');
  expect(owner.record.mock.calls[0][1]).toMatchObject({conversationId:NEW_CHAT});
  // A live chat keeps its continuation.
  expect(await askFromLauncherAction({question:'And the month after?',path:'/leave',previousExchangeId:'teras-turn-1',previousConversationToken:'tc1.live-chat.signature'})).toMatchObject({ok:true,chatId:CHAT});
  expect(owner.turn.mock.calls[1][2]).toMatchObject({continuation:'tc1.live-chat.signature'});
  // A continuation the check cannot read goes to the turn unchanged, whose own verification refuses it.
  owner.verify.mockImplementationOnce(()=>{throw new Error('bad signature');});
  await askFromLauncherAction({question:'Again?',path:'/leave',previousExchangeId:'teras-turn-1',previousConversationToken:'tc1.forged'});
  expect(owner.turn.mock.calls[2][2]).toMatchObject({continuation:'tc1.forged'});
 });
 it('withholds the words of a routed or refused turn: only the marker is recorded',async()=>{
  owner.route.mockResolvedValue(harness);
  for(const over of [{sensitive:true},{refused:true},{sensitive:true,crisis:true}]){
   owner.record.mockClear();owner.turn.mockResolvedValueOnce(harnessTurn(over));
   expect(await askFromWorkspaceAction({question:'My manager is harassing me.'})).toMatchObject({ok:true,chatId:CHAT});
   expect(owner.record.mock.calls[0][1]).toMatchObject({withheld:true});
  }
 });
 it('never changes the reply when storage fails or stores nothing, and stores no turn whose reply could not be shown',async()=>{
  owner.route.mockResolvedValue(harness);
  const logged=vi.spyOn(console,'error').mockImplementation(()=>{});
  try{
   owner.record.mockRejectedValueOnce(Object.assign(Error('PRIVATE store detail How much leave'),{code:'23514'}));
   expect(await askFromWorkspaceAction({question:'How much leave do I have?'})).toEqual({ok:true,exchangeId:'teras-turn-1',answer:'harness reply',conversationToken:'tc1.model-side.signature'});
   expect(logged).toHaveBeenLastCalledWith('[noveri conversation turn] chat not stored',{name:'Error',code:'23514',supportId:expect.stringMatching(/^[0-9a-f-]{36}$/)});
   expect(JSON.stringify(logged.mock.calls)).not.toMatch(/PRIVATE|How much leave/);
   owner.record.mockResolvedValueOnce(null);
   expect(await askFromWorkspaceAction({question:'How much leave do I have?'})).not.toHaveProperty('chatId');
   owner.record.mockClear();owner.render.mockRejectedValueOnce(Error('PRIVATE render detail'));
   expect(await askFromWorkspaceAction({question:'How much leave do I have?'})).toEqual({ok:false,message:'aiCentre.conversation.errors.provider_error'});
   expect(owner.record).not.toHaveBeenCalled();
  }finally{logged.mockRestore();}
 });
 it('reopens a stored chat for Ask: its words without the withheld turn, a fresh continuation on the harness route, read-only otherwise',async()=>{
  owner.reopen.mockResolvedValue({chatId:CHAT,companyId:'00000000-0000-4000-8000-00000000c0aa',earlierTurns:0,
   turns:[{seq:1,withheld:false,question:'How much leave do I have?',reply:'You have **12** days.'},{seq:2,withheld:true},{seq:3,withheld:false,question:'And next month?',reply:'The same.'}],
   history:[{role:'user',content:'How much leave do I have?'},{role:'assistant',content:'You have [an earlier figure] days.'}]});
  owner.issue.mockReturnValue('tc1.reopened.signature');
  owner.route.mockResolvedValue(harness);
  const reopened=await openStoredChatAction({chatId:CHAT});
  expect(owner.reopen).toHaveBeenCalledExactlyOnceWith(session,CHAT,SCOPE);
  expect(owner.issue).toHaveBeenCalledExactlyOnceWith(session,CHAT,[{role:'user',content:'How much leave do I have?',side:'model'},{role:'assistant',content:'You have [an earlier figure] days.',side:'model'}]);
  expect(reopened).toMatchObject({ok:true,chatId:CHAT,conversationToken:'tc1.reopened.signature'});
  if(!reopened.ok)throw Error('Expected a reopened chat.');
  expect(reopened.turns.map(turn=>[turn.id,turn.question])).toEqual([[`teras-chat-${CHAT}-1`,'How much leave do I have?'],[`teras-chat-${CHAT}-3`,'And next month?']]);
  expect(JSON.stringify(reopened.turns)).not.toContain('harass');
  // The switch closed (or unreadable): the chat opens read-only, with no continuation.
  owner.issue.mockClear();
  for(const route of [async()=>({route:'closed'}),async()=>{throw Error('PRIVATE switch failure');}]){
   owner.route.mockImplementationOnce(route);
   const readOnly=await openStoredChatAction({chatId:CHAT});
   expect(readOnly).toMatchObject({ok:true,chatId:CHAT});expect(readOnly).not.toHaveProperty('conversationToken');
  }
  expect(owner.issue).not.toHaveBeenCalled();
  // Refused by the owner (another login, scope or role, expired, no grant): one closed message.
  owner.reopen.mockRejectedValueOnce(Error('PRIVATE refusal'));
  expect(await openStoredChatAction({chatId:CHAT})).toEqual({ok:false,message:'assistant.workspace.conversation.unavailable'});
 });
 it('the panel and Ask continue one stored chat: the panel names it, Ask reopens it and the next turn goes on in it',async()=>{
  owner.route.mockResolvedValue(harness);
  const panel=await askFromLauncherAction({question:'How much leave do I have?',path:'/leave'});
  if(!panel.ok||!panel.chatId)throw Error('Expected a stored panel turn.');
  owner.reopen.mockResolvedValue({chatId:panel.chatId,companyId:'00000000-0000-4000-8000-00000000c0aa',earlierTurns:0,
   turns:[{seq:1,withheld:false,question:'How much leave do I have?',reply:'You have 12 days.'}],history:[{role:'user',content:'How much leave do I have?'}]});
  owner.issue.mockReturnValue('tc1.reopened.signature');
  const ask=await openStoredChatAction({chatId:panel.chatId});
  if(!ask.ok||!ask.conversationToken)throw Error('Expected a continuable chat.');
  // The Ask page seeds the conversation with exchangeId 'teras-chat-<id>' and the fresh continuation.
  await askFromWorkspaceAction({question:'And next month?',previousExchangeId:'teras-chat-'+panel.chatId,previousConversationToken:ask.conversationToken});
  expect(owner.turn.mock.calls.at(-1)?.[2]).toMatchObject({question:'And next month?',continuation:'tc1.reopened.signature'});
  expect(owner.record.mock.calls.map(call=>call[1].conversationId)).toEqual([panel.chatId,panel.chatId]);
 });
});

