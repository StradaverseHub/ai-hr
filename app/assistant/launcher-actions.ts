'use server';

import type { ReactNode } from 'react';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { getBrowserCommandSession } from '@/lib/session';
import { AuthRequiredError } from '@/lib/auth-errors';
import { askAssistant, AssistantError } from '@/core/assistant';
import { loadAiWorkspace } from '@/core/ai-workspace';
import { resolvePageContext } from '@/lib/ai/page-context';
import { GroundedWorkspaceReply } from '@/components/assistant/module-jobs';

export type LauncherReply =
  | { ok: true; exchangeId: string; answer: ReactNode }
  | { ok: false; message: string };

/** The floating Assistant's one command. The same askAssistant path as the Assistant page: grant, module,
 * pause, allowances and provider are all re-checked there. The page context is RE-DERIVED here from the
 * posted path through a closed list (an area, and at most one record id); posted labels are never used.
 * The context is appended to the question in plain view, so the person's history and the audit row show
 * exactly what was sent. The answer is the same server-rendered canonical card the Assistant shows. */
export async function askFromLauncherAction(input: { question: unknown; path: unknown }): Promise<LauncherReply> {
  const t = await getTranslations('assistant');
  const question = typeof input.question === 'string' ? input.question.trim() : '';
  const context = resolvePageContext(input.path);
  let text = question;
  if (context) {
    const areas = await getTranslations('assistant.launcher.areas');
    text = `${question}\n\n[${t('launcher.contextNote', { area: areas(context.area) })}${context.recordId ? ` · ${context.recordId}` : ''}]`;
  }
  if (!question || text.length > 2000) return { ok: false, message: t('err_invalid_question') };
  try {
    const session = await getBrowserCommandSession();
    const { exchangeId } = await askAssistant(session, { question: text });
    revalidatePath('/assistant');
    const workspace = await loadAiWorkspace(session, { selectedExchangeId: exchangeId, includeGovernance: false });
    const exchange = workspace.history.find(row => row.id === exchangeId);
    const answer = exchange?.grounded
      ? await GroundedWorkspaceReply({ reply: exchange.grounded, ctx: session, exchangeId })
      : null;
    return { ok: true, exchangeId, answer };
  } catch (error) {
    const code = error instanceof AuthRequiredError ? 'ai_control' : error instanceof AssistantError ? error.code : 'provider_error';
    return { ok: false, message: t.has(`err_${code}`) ? t(`err_${code}`) : t('err_provider_error') };
  }
}
