/** @vitest-environment jsdom */
/** Exercises the shared host/reply client entry. The production route manifests and installed RSC
 * transport remain separate build/browser checks; a DOM render cannot prove manifest admission. */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {AssistantReplyClientEntry,AssistantChatBoundary,ConversationClarification} from '../components/assistant/chat-reply-boundary';
vi.mock('../app/assistant/actions',()=>({askAssistantAction:vi.fn()}));
afterEach(cleanup);
it('preserves the exact owned clarification transport through the shared server/client entry',()=>{
 const clarify=vi.fn().mockResolvedValue(undefined),answer='Hello, what can you help me do?';
 const show=(pending:boolean)=><AssistantReplyClientEntry><AssistantChatBoundary value={{pending,clarify}}><ConversationClarification exchangeId="owned-exchange" replyLabel="Your reply" continueLabel="Continue"/></AssistantChatBoundary></AssistantReplyClientEntry>;
 const view=render(show(false));fireEvent.change(screen.getByLabelText('Your reply'),{target:{value:answer}});fireEvent.click(screen.getByRole('button',{name:'Continue'}));
 expect(clarify).toHaveBeenCalledExactlyOnceWith('owned-exchange',answer);
 view.rerender(show(true));expect(screen.getByRole('button',{name:'Continue'})).toBeDisabled();expect(screen.getByLabelText('Your reply')).toHaveAttribute('readonly');
 fireEvent.submit(screen.getByRole('button',{name:'Continue'}).closest('form')!);expect(clarify).toHaveBeenCalledTimes(1);
});
