/**
 * Which module-owned nav rows this session may SEE (ADR-0077 slice 4).
 *
 * COSMETIC, AND THAT IS THE ENTIRE CONTRACT. Hiding a row is not a permission — D3 puts enforcement at
 * the service boundary, where assertModuleEnabled throws ModuleNotEnabledError however the page was
 * reached. This file only stops the rail from advertising a module the customer has not bought. Typing
 * the address still reaches a page that refuses.
 *
 * FAILS OPEN, DELIBERATELY, AND THIS IS THE ONE DECISION WORTH ARGUING WITH.
 *
 * getSession degrades rather than 500s: a code-ahead-of-migration deploy, a revoked grant or a
 * connection blip returns a session with NO snapshot and an `entitlementsError` recording why. Every
 * service gate then refuses at the point of use — fail-closed, correctly, because a service that
 * guesses moves money.
 *
 * Nav must do the OPPOSITE. Fail-closed here means an infrastructure blip empties the sidebar for every
 * user of a paying tenant, on every page, while the pages themselves still work. The customer sees
 * their product apparently uninstalled. Fail-open means the rail shows a row whose page then refuses
 * with a clear message — the pre-slice-4 behaviour, which is exactly what "cosmetic layer" should
 * degrade to. Showing a link to something you cannot use is a worse menu; hiding everything is a worse
 * outage, and the service layer is the control either way.
 *
 * So: no snapshot ⇒ show everything. A resolved snapshot ⇒ hide what is genuinely off.
 */
import { CORE_MODULE_CODES } from '@/packs/catalog';
import { isModuleEnabled, type EntitledContext } from '@/core/entitlements';

/**
 * The module codes that actually contribute nav, i.e. the packs the sidebar mounts by id. Listed here
 * rather than derived from the pack registry because this module is imported by a SERVER component
 * (app/layout.tsx) and the registry's side-effect import pulls the client wiring in with it — the same
 * trap ADR-0080 rung 2 records against listPacks.
 */
export const MODULE_CODES_WITH_NAV = ['attendance', 'claims', 'leave', 'payroll', 'performance'] as const;

/** Module codes whose nav rows are always shown, whatever the snapshot says. */
const CORE = new Set<string>(CORE_MODULE_CODES);

/**
 * The set of module codes whose nav the rail should render.
 *
 * Returns `null` to mean "no opinion — show everything", which is distinct from an empty set ("show
 * nothing"). The Sidebar treats the two differently on purpose; collapsing them into one empty array
 * is how a degraded session would silently become a blank menu.
 */
export function visibleModuleCodes(session: unknown): string[] | null {
  const ctx = session as EntitledContext & { entitlementsError?: string };
  // No snapshot resolved (or the resolve failed and recorded why) — see the fail-open note above.
  if (!ctx || typeof ctx !== 'object' || !('entitlements' in ctx) || ctx.entitlements == null) return null;

  const codes: string[] = [];
  for (const code of MODULE_CODES_WITH_NAV) {
    if (CORE.has(code)) {
      codes.push(code);
      continue;
    }
    // isModuleEnabled can still throw for a malformed context even past the guard above; treat that the
    // same as "no opinion" rather than letting the rail take the page down.
    try {
      if (isModuleEnabled(ctx, code)) codes.push(code);
    } catch {
      return null;
    }
  }
  return codes;
}
