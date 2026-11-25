/**
 * Saves that keep the app frame (ADR 0181 decision 4, Phase 3).
 *
 * A server action that calls revalidatePath, updateTag or refresh, or that ends in redirect(), makes Next draw the
 * WHOLE tree again inside the action's response, app frame included: an action request carries no router state, so
 * the render starts at the root layout (next/dist/server/route-modules/app-page/parse-request-headers.js, Next 16.4.1).
 * router.refresh() does the same from the client. The frame is the menus, access checks and badges: about 1.1 s of
 * database work per draw on staging.
 *
 * Instead, a form rendered with <ActionNavigateForm> marks its submission, the action does its write and returns where
 * to go, and the client navigates in-app. A navigation sends the router state, so only the page below the root
 * layout is drawn; the shell's approval facts are re-read on their own when the save changes them. This generalises
 * the Export to Excel form (app/payroll/transaction-view/workbook-export-form.tsx).
 *
 * The same action still works from a plain <form>: without the mark it revalidates and redirects as before. Forms
 * move over one at a time.
 *
 * Next's data tags (updateTag) are not used: this application caches no data with `use cache`, so a tag has nothing
 * to expire, and updateTag also redraws the whole tree in the action's response.
 */

/** The form field <ActionNavigateForm> adds to its submission. */
export const ACTION_NAVIGATION_FIELD = '__aihrNavigation';

/** What an action returns to <ActionNavigateForm> instead of redirecting. */
export type ActionNavigation = {
  /** The in-app address to open next. It may carry ?toast=, ?error= and ?approvalSeal=1 feedback. */
  navigate: string;
  /** The save changed what the shell's badges and bell count, so re-read the shell's approval facts. */
  refreshShellApprovals?: boolean;
};

/** Whether this submission came from <ActionNavigateForm>, which navigates itself. */
export function requestsClientNavigation(formData: FormData | null | undefined): boolean {
  return formData?.get(ACTION_NAVIGATION_FIELD) === 'client';
}

/**
 * The address when it is an in-app path, otherwise null. A server action is a public endpoint and its result is only
 * ever followed inside this application: no scheme, host, protocol-relative or backslash form.
 */
export function inAppHref(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  return value;
}

/** Feedback parameters the destination's toast shows (components/ui/toast-trigger.tsx). */
export const ACTION_FEEDBACK_PARAMS = ['toast', 'error', 'approvalSeal'] as const;

/** Splits an in-app address into the address without feedback parameters and the feedback itself. */
export function splitActionFeedback(href: string): { href: string; feedback: URLSearchParams } {
  const url = new URL(href, 'http://in-app.invalid');
  const feedback = new URLSearchParams();
  for (const key of ACTION_FEEDBACK_PARAMS) {
    const value = url.searchParams.get(key);
    if (value !== null) feedback.set(key, value);
    url.searchParams.delete(key);
  }
  const search = url.searchParams.toString();
  return { href: `${url.pathname}${search ? `?${search}` : ''}${url.hash}`, feedback };
}
