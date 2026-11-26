import { loginOrganization } from './login-navigation';

/**
 * The workspace code this browser last signed in with. It is a presentation convenience for the login
 * form only: it never selects a principal, establishes authentication or overrides an explicit link.
 * Organization codes are issued to every employee of a workspace, so remembering one is not a secret.
 * Storage may be unavailable (private windows, blocked site data); every access fails closed to "none".
 */
export const REMEMBERED_WORKSPACE_KEY = 'aihr.login.workspace';

export function rememberedWorkspace(): string {
  try { return loginOrganization(window.localStorage.getItem(REMEMBERED_WORKSPACE_KEY)); } catch { return ''; }
}

export function rememberWorkspace(value: unknown): void {
  const code = loginOrganization(value);
  if (!code) return;
  try { window.localStorage.setItem(REMEMBERED_WORKSPACE_KEY, code); } catch { /* storage unavailable */ }
}
