'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import { AgentActionError, executeAction } from '@/core/agent-actions';

const PAGE = '/control-tower/actions';

/**
 * ADR-0083 §2.5 — approve one proposal.
 *
 * `getAll('verdictId')` because the form posts one hidden input per subject: the operator approves the
 * LIST THEY SAW, not a count or a filter. A filter re-evaluated server-side could pick up a row that
 * appeared between render and click, which the human never looked at.
 *
 * The core re-checks every id's precondition anyway (§2.5 property 2), so this action stays thin: it
 * carries the approval and reports what actually happened, including the ones it refused.
 */
export async function approveAgentActionAction(formData: FormData) {
  const s = await requireAdmin();
  const typeId = String(formData.get('typeId') ?? '');
  const verdictIds = formData.getAll('verdictId').map(String);

  let result: Awaited<ReturnType<typeof executeAction>>;
  try {
    result = await executeAction(s, { typeId, verdictIds });
  } catch (e) {
    const code = e instanceof AgentActionError ? e.code : 'failed';
    redirect(`${PAGE}?error=${encodeURIComponent(code)}`);
  }

  revalidatePath(PAGE);
  revalidatePath('/control-tower');
  // Both numbers travel back. Reporting only the successes would hide the re-check doing its job.
  redirect(`${PAGE}?closed=${result.closed}&stale=${result.stale}`);
}
