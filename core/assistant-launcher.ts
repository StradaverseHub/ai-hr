/** The floating Assistant button: tenant settings, who sees it, and the group-admin writer.
 * Seeing the button grants nothing. Every question it sends goes through askAssistant, which re-checks the
 * module, the per-login grant, the pause switch, allowances and the provider exactly as the Assistant page
 * does. Hiding the button is presentation only. */
import { withTenant, type SessionContext } from '../db/client';
import { getSetting } from './entitlements';
import { resolveActiveAiConfig } from './ai-config';
import { mayUseAssistant } from './assistant-grant';
import { setTenantSetting } from './tenant-settings';
import { isPageArea, PAGE_AREAS, type PageArea } from '../lib/ai/page-context';

export const LAUNCHER_POSITIONS = ['bottom-right', 'bottom-left'] as const;
export type LauncherPosition = (typeof LAUNCHER_POSITIONS)[number];
export type LauncherSettings = { enabled: boolean; position: LauncherPosition; hiddenAreas: PageArea[] };

const parseAreas = (value: unknown): PageArea[] => typeof value !== 'string' ? [] : [...new Set(value.split(',').map(part => part.trim()).filter(isPageArea))];

/** The saved settings (catalog defaults: off, bottom-right, nothing hidden). Throws when the tenant's
 * settings cannot be read; callers decide what that means (the shell hides the button). */
export function readLauncherSettings(ctx: SessionContext): LauncherSettings {
  const position = getSetting<unknown>(ctx, 'assistant.launcher_position');
  return {
    enabled: getSetting<unknown>(ctx, 'assistant.launcher_enabled') === true,
    position: LAUNCHER_POSITIONS.find(p => p === position) ?? 'bottom-right',
    hiddenAreas: parseAreas(getSetting<unknown>(ctx, 'assistant.launcher_hidden_areas')),
  };
}

/** What the shell renders: null unless the tenant switched the button on, this login may use the
 * Assistant and a provider is active. Any failure hides it; it never fails open. */
export async function assistantLauncherFor(ctx: SessionContext): Promise<Omit<LauncherSettings, 'enabled'> | null> {
  try {
    const settings = readLauncherSettings(ctx);
    if (!settings.enabled) return null;
    if (!(await mayUseAssistant(ctx)).allowed) return null;
    if (!(await withTenant(ctx, tx => resolveActiveAiConfig(tx, ctx)))) return null;
    return { position: settings.position, hiddenAreas: settings.hiddenAreas };
  } catch { return null; }
}

export class LauncherSettingsError extends Error { constructor() { super('Invalid floating Assistant settings.'); this.name = 'LauncherSettingsError'; } }

/** Group administrators only (setTenantSetting re-proves it inside the transaction); all three settings
 * change together or not at all. */
export async function setAssistantLauncher(ctx: SessionContext, input: { enabled: unknown; position: unknown; hiddenAreas: unknown }): Promise<void> {
  if (typeof input.enabled !== 'boolean' || !LAUNCHER_POSITIONS.some(p => p === input.position)
    || !Array.isArray(input.hiddenAreas) || input.hiddenAreas.length > PAGE_AREAS.length || !input.hiddenAreas.every(isPageArea)) throw new LauncherSettingsError();
  const hidden = PAGE_AREAS.filter(area => (input.hiddenAreas as unknown[]).includes(area)).join(',');
  await withTenant(ctx, async tx => {
    await setTenantSetting(ctx, { key: 'assistant.launcher_enabled', value: input.enabled as boolean }, tx);
    await setTenantSetting(ctx, { key: 'assistant.launcher_position', value: input.position as string }, tx);
    await setTenantSetting(ctx, { key: 'assistant.launcher_hidden_areas', value: hidden }, tx);
  });
}
