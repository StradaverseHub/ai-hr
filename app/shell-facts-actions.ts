'use server';

import { getSession } from '@/lib/session';
import type { ShellApprovalResult } from '@/components/shell-approval-facts';
import { readShellApprovalFacts } from './shell-approval-facts-read';

/**
 * The shell's approval facts, re-read after a save that kept the app frame (ADR 0181 decision 4). It only reads and
 * never revalidates, so Next draws nothing: the badges and the bell's Task tab update from the returned value.
 */
export async function refreshShellApprovalFactsAction(): Promise<ShellApprovalResult> {
  return readShellApprovalFacts(await getSession());
}
