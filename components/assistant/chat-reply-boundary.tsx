"use client";
import type {ComponentProps,ReactNode} from 'react';
import {AssistantChatSubmitContext} from './chat-submit-context';
import {ConversationClarification as Clarification} from './conversation-clarification';
import {ConversationActionProposal as Proposal} from './conversation-action-proposal';

/** Both chat hosts and server-produced reply controls use this one client entry. A reply returned
 * by a Server Action must reference the host route's manifest, not an Assistant-page-only module.
 * Wrappers intentionally keep the RSC references on this entry; native owners still adjudicate. */
/** Explicitly rendered by the server shell so this entry is registered for every chat host route. */
export function AssistantReplyClientEntry({children}:{children:ReactNode}){return <>{children}</>;}
export function AssistantChatBoundary({value,children}:{value:NonNullable<ComponentProps<typeof AssistantChatSubmitContext.Provider>['value']>;children:ReactNode}){
 return <AssistantChatSubmitContext.Provider value={value}>{children}</AssistantChatSubmitContext.Provider>;
}
export function ConversationClarification(props:ComponentProps<typeof Clarification>){return <Clarification {...props}/>;}
export function ConversationActionProposal(props:ComponentProps<typeof Proposal>){return <Proposal {...props}/>;}
