import type { EmailAsset } from './lifecycle-v9-model';
export const v9ImageTokens = (text: string) => [...new Set([...text.matchAll(/\{image:([^{}\s]+)\}/g)].map(match => match[1]))];
export const v9ImageCid = (id: string) => `v9-image.${id}@aihr`;
const escape = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
/** Textarea content stays text. Only owned inline-image tokens produce HTML elements. */
export function v9EmailContent(body: string, images: EmailAsset[]): { text: string; html?: string } {
  const byId = new Map(images.map(image => [image.id,image]));
  for (const id of v9ImageTokens(body)) if (!byId.has(id)) throw new Error('An inline image is unavailable');
  const text = body.replace(/\{image:([^{}\s]+)\}/g, (_,id: string) => `[Image: ${byId.get(id)!.name}]`);
  if (!v9ImageTokens(body).length) return { text };
  const parts = body.split(/(\{image:[^{}\s]+\})/g).map(part => {
    const token = part.match(/^\{image:([^{}\s]+)\}$/), image = token ? byId.get(token[1]) : null;
    return image ? `<img src="cid:${v9ImageCid(image.id)}" alt="${escape(image.name)}" style="max-width:100%;height:auto"/>` : escape(part).replace(/\n/g,'<br/>');
  });
  return { text, html: `<div>${parts.join('')}</div>` };
}
