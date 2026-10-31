import { getSettingOrFallback, type EntitledContext } from '@/core/entitlements';

/**
 * Operator switch (0696): whether this customer's Feedback board is open. Platform-scoped, so only an
 * operator changes it. The board's pages and actions fail CLOSED when the snapshot cannot resolve; the
 * rail (app/(app)/layout.tsx) reads the same key through settingEnabledOrDefault and fails open, per
 * lib/nav-entitlements.ts.
 */
export function feedbackBoardOpen(ctx: EntitledContext): boolean {
  return getSettingOrFallback<boolean>(ctx, 'feedback.menu_enabled', false) === true;
}
