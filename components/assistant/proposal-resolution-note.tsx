'use client';
/** ADR-0151 §4.3: how a chat proposal's hints matched the caller's own fresh choices. One match is
 * preselected; zero or several ask the person to pick. Never a guess. */
import {useTranslations} from 'next-intl';
import type {ProposalResolutionKind} from '@/lib/ai/assistant-action-proposal-hints';
export function ProposalResolutionNote({kind}:{kind:ProposalResolutionKind}){
 const t=useTranslations('assistant.workspace.proposal');
 return <p role="note" className="rounded-md bg-muted/40 px-3 py-2 text-sm">{t(kind==='one'?'resolutionOne':kind==='several'?'resolutionSeveral':'resolutionNone')}</p>;
}
