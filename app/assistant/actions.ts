'use server';
import { startAssistantConversation, submitAssistantConversationTurn, confirmAssistantConversationProposal, resetAssistantConversation, rateAssistantConversationReply } from '@/core/assistant-conversation';
import { ensureAssistantDemoNonce } from '@/lib/assistant-session';
import { AssistantConversationError, type AssistantConversationFailure } from '@/lib/assistant-conversation-model';
import { conversationCopy } from './copy';
const failure = (error: unknown): {
    ok: false;
    code: AssistantConversationFailure;
} => ({ ok: false, code: error instanceof AssistantConversationError ? error.code : 'unavailable' });
export async function loadAssistantConversationAction() { try {
    await ensureAssistantDemoNonce();
    return { ok: true as const, view: await startAssistantConversation() };
}
catch (error) {
    return failure(error);
} }
export async function submitAssistantConversationAction(raw: unknown) { try {
    return { ok: true as const, view: await submitAssistantConversationTurn(raw, await conversationCopy()) };
}
catch (error) {
    return failure(error);
} }
export async function confirmAssistantProposalAction(raw: unknown) { try {
    return { ok: true as const, view: await confirmAssistantConversationProposal(raw, await conversationCopy()) };
}
catch (error) {
    return failure(error);
} }
export async function newAssistantConversationAction(id: string) { try {
    return { ok: true as const, view: await resetAssistantConversation(id) };
}
catch (error) {
    return failure(error);
} }
export async function rateAssistantReplyAction(raw: {
    conversationId: string;
    exchangeId: string;
    helpful: boolean;
}) { try {
    await rateAssistantConversationReply(raw);
    return { ok: true as const };
}
catch (error) {
    return failure(error);
} }
