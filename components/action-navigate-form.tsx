'use client';

import type { FormHTMLAttributes, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useShellApprovalFacts } from '@/components/shell-approval-facts';
import { useActionFeedbackToast } from '@/components/ui/toast-trigger';
import { ACTION_NAVIGATION_FIELD, inAppHref, splitActionFeedback, type ActionNavigation } from '@/lib/action-navigation';

type FormProps = Omit<FormHTMLAttributes<HTMLFormElement>, 'action' | 'children'>;

/**
 * A drop-in <form> for a server action that keeps the app frame (ADR 0181 decision 4; lib/action-navigation.ts).
 *
 * It marks the submission, so the action returns where to go instead of revalidating and redirecting. Then it shows
 * the action's feedback, opens the address with an in-app navigation (only the page below the root layout is drawn)
 * and, when the save changed them, re-reads the shell's approval facts. An action that still redirects (a refused
 * session, an older action) is followed by Next as before; one that returns nothing leaves the page as it is.
 */
export function ActionNavigateForm({ action, children, ...form }: FormProps & {
  action: (formData: FormData) => Promise<ActionNavigation | void | undefined>;
  children?: ReactNode;
}) {
  const router = useRouter();
  const shell = useShellApprovalFacts();
  const showFeedback = useActionFeedbackToast();
  return (
    <form {...form} action={async (formData) => {
      formData.set(ACTION_NAVIGATION_FIELD, 'client');
      const result = await action(formData);
      const target = result ? inAppHref(result.navigate) : null;
      if (!result || !target) return;
      const { href, feedback } = splitActionFeedback(target);
      showFeedback(feedback);
      router.push(href);
      if (result.refreshShellApprovals) void shell?.refresh();
    }}>
      {children}
    </form>
  );
}
