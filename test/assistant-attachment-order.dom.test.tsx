/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const ports=vi.hoisted(()=>({ask:vi.fn(),earlier:vi.fn()}));
vi.mock('../app/assistant/launcher-actions',()=>({askFromWorkspaceAction:ports.ask,loadEarlierChatAction:ports.earlier}));
// The import controller owns source/consent. This port exercises transcript placement independently.
vi.mock('../components/assistant/workspace-composer',()=>({WorkspaceComposer:(props:any)=><div>
 <button onClick={()=>props.onAttachmentTurn({id:'file',question:'File question',answer:<p>File review</p>})}>Attach source</button>
 <button onClick={()=>props.onAttachmentTurn({id:'file',question:'File question',answer:<p>Updated file review</p>})}>Update review</button>
 <form onSubmit={event=>{event.preventDefault();void props.action(new FormData(event.currentTarget));}}><input aria-label="Message" name="question" value={props.question} onChange={event=>props.onQuestionChange(event.target.value)}/><button type="submit">Send</button></form>
 </div>}));
import {WorkspaceConversation} from '../components/assistant/workspace-conversation';
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('keeps file preparation between its preceding and following turns when its review changes or earlier history is prepended',async()=>{
 ports.ask.mockResolvedValue({ok:true,exchangeId:'next',conversationToken:'proof-next',answer:<p>Later answer</p>});
 ports.earlier.mockResolvedValue({ok:true,turns:[{id:'older',question:'Older question',answer:<p>Older answer</p>}],olderCursor:null});
 render(<NextIntlClientProvider locale="en" messages={en}><WorkspaceConversation tasks={[]} fileImport fullHeight initialTurns={[{id:'first',question:'First question',answer:<p>First answer</p>}]} initialResume={{exchangeId:'first',conversationToken:'proof-first'}} historyTailId="first" olderCursor="older-page"/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Attach source'}));await screen.findByText('File review');
 fireEvent.change(screen.getByRole('textbox',{name:'Message'}),{target:{value:'Later question'}});fireEvent.click(screen.getByRole('button',{name:'Send'}));await screen.findByText('Later answer');
 fireEvent.click(screen.getByRole('button',{name:'Update review'}));await screen.findByText('Updated file review');
 fireEvent.click(screen.getByRole('button',{name:en.assistant.workspace.chat.older}));await screen.findByText('Older answer');
 const precedes=(a:string,b:string)=>expect(screen.getByText(a).compareDocumentPosition(screen.getByText(b))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 precedes('Older answer','First answer');precedes('First answer','Updated file review');precedes('Updated file review','Later question');
 expect(ports.ask).toHaveBeenCalledExactlyOnceWith({question:'Later question',previousExchangeId:'first',previousConversationToken:'proof-first'});
});

it('follows attachment updates only while the reader is near the latest turn',async()=>{
 render(<NextIntlClientProvider locale="en" messages={en}><WorkspaceConversation tasks={[]} fileImport fullHeight/></NextIntlClientProvider>);
 const log=screen.getByRole('log');Object.defineProperties(log,{scrollHeight:{configurable:true,value:1000},clientHeight:{configurable:true,value:200}});
 log.scrollTop=780;fireEvent.scroll(log);fireEvent.click(screen.getByRole('button',{name:'Attach source'}));await screen.findByText('File review');expect(log.scrollTop).toBe(1000);
 log.scrollTop=100;fireEvent.scroll(log);fireEvent.click(screen.getByRole('button',{name:'Update review'}));await screen.findByText('Updated file review');expect(log.scrollTop).toBe(100);
});
