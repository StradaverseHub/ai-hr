/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {AssistantChatBoundary,ConversationSuggestions} from '../components/assistant/chat-reply-boundary';
afterEach(cleanup);
it('fills the one composer without submitting, preparing or changing the active owned clarification',()=>{
 const setQuestionDraft=vi.fn(),clarify=vi.fn(),suggestions=[{label:'Check my leave',prompt:'My leave balance'},{label:'Track my claims',prompt:'My claims'}];
 const view=render(<AssistantChatBoundary value={{pending:false,clarify,setQuestionDraft}}><ConversationSuggestions label="Suggested next steps" suggestions={suggestions}/></AssistantChatBoundary>);
 fireEvent.click(screen.getByRole('button',{name:'Check my leave'}));expect(setQuestionDraft).toHaveBeenCalledExactlyOnceWith('My leave balance');expect(clarify).not.toHaveBeenCalled();
 view.rerender(<AssistantChatBoundary value={{pending:true,clarify,setQuestionDraft}}><ConversationSuggestions label="Suggested next steps" suggestions={suggestions}/></AssistantChatBoundary>);
 expect(screen.getByRole('button',{name:'Track my claims'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'Track my claims'}));expect(setQuestionDraft).toHaveBeenCalledTimes(1);
});
it('does not show disconnected controls without an active chat composer',()=>{render(<ConversationSuggestions label="Next" suggestions={[{label:'A',prompt:'B'}]}/>);expect(screen.queryByRole('button')).toBeNull();});
