/** Public presentation only. No identity, tenant profile or authentication settings are serialized. */
export type LoginPresentation = { mediaType: 'none' | 'image' | 'gif' | 'video'; mediaUrl: string; alt: string; iconUrl: string };
export const DEFAULT_LOGIN_PRESENTATION: LoginPresentation = { mediaType: 'none', mediaUrl: '', alt: '', iconUrl: '' };

export function validateLoginPresentation(value: unknown): LoginPresentation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
  const v = value as Record<string, unknown>;
  if (!['none', 'image', 'gif', 'video'].includes(String(v.mediaType)) || typeof v.mediaUrl !== 'string' || typeof v.alt !== 'string' || typeof v.iconUrl !== 'string') throw new Error('invalid');
  const mediaType = v.mediaType as LoginPresentation['mediaType'];
  const mediaUrl = v.mediaUrl.trim(), alt = v.alt.trim();
  if (mediaUrl.length > 2048 || alt.length > 240) throw new Error('invalid');
  const iconUrl = typeof v.iconUrl === 'string' ? v.iconUrl.trim() : '';
  if (iconUrl) {
    let icon: URL;
    try { icon = new URL(iconUrl); } catch { throw new Error('invalid'); }
    if (iconUrl.length > 2048 || icon.protocol !== 'https:' || icon.username || icon.password || icon.hash) throw new Error('invalid');
  }
  if (mediaType === 'none') return { ...DEFAULT_LOGIN_PRESENTATION, iconUrl };
  let url: URL;
  try { url = new URL(mediaUrl); } catch { throw new Error('invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !alt) throw new Error('invalid');
  return { mediaType, mediaUrl: url.href, alt, iconUrl };
}
