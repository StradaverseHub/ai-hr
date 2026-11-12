import { type EmailBodyDoc, type EmailBlock, type EmailFlowBlock, type EmailInline, type EmailParagraph } from './doc';

/**
 * Today's plain-text template body <-> EmailBodyDoc. Pure (no DOM).
 *
 * Representation, chosen so that docToLegacyText(legacyBodyToDoc(body)) === body for EVERY body using \n line ends:
 *   - the body is split on each "\n\n" (left to right) into paragraphs; so "a\n\n\nb" is P(a) + P(break, b) and
 *     "a\n\n\n\nb" is P(a) + P() + P(b). Empty paragraphs and leading breaks carry the extra blank lines.
 *   - a remaining single "\n" is a hardBreak (a trailing newline is a trailing hardBreak).
 *   - {key} (the merge() grammar) is a field atom; {image:id} of an uploaded image is an image node (alt = its name).
 *   - everything else is verbatim text: "<", "&", leading spaces, "{image:unknown}", "{not a field}", "{".
 * Line ends: "\r\n" and a lone "\r" are read as "\n" (the editor has no carriage returns), so a CRLF body round-trips
 * to its LF form. Unedited legacy templates keep the legacy send path; this conversion only feeds the editor.
 */
const TOKEN = /\{([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)?)\}|\{image:([^{}\s]+)\}/g;

export function legacyBodyToDoc(body: string, images: readonly { id: string; name: string }[] = []): EmailBodyDoc {
  const byId = new Map(images.map(image => [image.id, image]));
  const lines = body.replace(/\r\n?/g, '\n');
  const content: EmailParagraph[] = lines.split('\n\n').map(part => {
    const inline: EmailInline[] = [];
    part.split('\n').forEach((line, index) => {
      if (index) inline.push({ type: 'hardBreak' });
      let last = 0;
      for (const match of line.matchAll(TOKEN)) {
        const [token, key, imageId] = match;
        const image = imageId ? byId.get(imageId) : undefined;
        if (!key && !image) continue; // an unknown image token stays text
        if (match.index! > last) inline.push({ type: 'text', text: line.slice(last, match.index) });
        inline.push(key ? { type: 'field', attrs: { key } } : { type: 'image', attrs: { assetId: image!.id, alt: image!.name.slice(0, 300) } });
        last = match.index! + token.length;
      }
      if (last < line.length) inline.push({ type: 'text', text: line.slice(last) });
    });
    return inline.length ? { type: 'paragraph', content: mergeText(inline) } : { type: 'paragraph' };
  });
  return { type: 'doc', content };
}

// Adjacent text nodes (an unknown image token next to text) are joined so the doc matches what the editor emits.
function mergeText(list: EmailInline[]): EmailInline[] {
  const out: EmailInline[] = [];
  for (const node of list) {
    const previous = out.at(-1);
    if (node.type === 'text' && previous?.type === 'text' && !previous.marks && !node.marks) out[out.length - 1] = { type: 'text', text: previous.text + node.text };
    else out.push(node);
  }
  return out;
}

const inlineText = (list: EmailInline[] = []) => list.map(node => node.type === 'text' ? node.text : node.type === 'hardBreak' ? '\n'
  : node.type === 'field' ? `{${node.attrs.key}}` : `{image:${node.attrs.assetId}}`).join('');

function flowText(blocks: EmailFlowBlock[], indent = ''): string[] {
  return blocks.flatMap(item => {
    if (item.type === 'paragraph') return [indent + inlineText(item.content).replace(/\n/g, `\n${indent}`)];
    const start = item.type === 'orderedList' ? item.attrs?.start ?? 1 : 1;
    return [item.content.map((li, index) => {
      const bullet = item.type === 'orderedList' ? `${start + index}. ` : '- ';
      const [first, ...rest] = flowText(li.content, indent + '  ');
      return [indent + bullet + (first ?? '').slice(indent.length + 2), ...rest].join('\n');
    }).join('\n')];
  });
}
const blockText = (item: EmailBlock): string => item.type === 'table'
  ? item.content.map(tr => tr.content.map(td => flowText(td.content).join(' ').replace(/\n/g, ' ')).join(' | ')).join('\n')
  : flowText([item]).join('\n\n');

/**
 * Inverse of legacyBodyToDoc: exact for any doc it produced. For richer docs (marks, links, lists, tables) it is a
 * readable best effort — marks and link targets are dropped, lists become "- "/"1. " lines and table rows "a | b".
 * Field atoms and images are written back as {key} and {image:id} tokens.
 */
export function docToLegacyText(doc: EmailBodyDoc): string {
  return doc.content.map(blockText).join('\n\n');
}
