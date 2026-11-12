import type { EmailBodyDoc } from './doc';
/** Removes every image node that references an asset, e.g. when the image itself is removed from the template. */
export function withoutEmailImage(doc: EmailBodyDoc, assetId: string): EmailBodyDoc {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.filter(child => !(child && typeof child === 'object' && (child as { type?: string }).type === 'image' && (child as { attrs?: { assetId?: string } }).attrs?.assetId === assetId)).map(walk);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value)]));
    return node;
  };
  return walk(doc) as EmailBodyDoc;
}
