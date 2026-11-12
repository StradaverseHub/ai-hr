import type { EmailBodyDoc } from './doc';

/**
 * tiptap JSON <-> EmailBodyDoc. Node/mark names are shared, so this only cleans attributes: tiptap's defaults
 * (colwidth, null link attrs, ordered list type) are dropped and the table header row is derived from the first
 * row's cell types. Anything unexpected is passed through unchanged so the strict schema reports it rather than
 * this mapper silently discarding content. Pure JSON — no tiptap import (rule 7).
 */
export type EditorJson = { type?: string; attrs?: Record<string, unknown>; content?: EditorJson[]; marks?: { type: string; attrs?: Record<string, unknown> }[]; text?: string };

const cleanMarks = (marks: EditorJson['marks']) => {
  if (!marks?.length) return undefined;
  return marks.map(mark => {
    if (mark.type !== 'link') return mark.attrs && Object.keys(mark.attrs).length ? mark : { type: mark.type };
    const { kind, href, documentId } = mark.attrs ?? {};
    return { type: 'link', attrs: { kind, ...(href ? { href } : {}), ...(documentId ? { documentId } : {}) } };
  });
};
const withContent = <T extends object>(node: T, content: unknown[] | undefined) => content?.length ? { ...node, content } : node;

function fromNode(node: EditorJson): unknown {
  switch (node.type) {
    case 'text': { const marks = cleanMarks(node.marks); return marks ? { type: 'text', text: node.text ?? '', marks } : { type: 'text', text: node.text ?? '' }; }
    case 'hardBreak': return { type: 'hardBreak' };
    case 'field': { const marks = cleanMarks(node.marks); return { type: 'field', attrs: { key: String(node.attrs?.key ?? '') }, ...(marks ? { marks } : {}) }; }
    case 'image': return { type: 'image', attrs: { assetId: String(node.attrs?.assetId ?? ''), alt: String(node.attrs?.alt ?? '') } };
    case 'paragraph': return withContent({ type: 'paragraph' }, node.content?.map(fromNode));
    case 'bulletList': case 'listItem': return { type: node.type, content: (node.content ?? []).map(fromNode) };
    case 'orderedList': {
      const start = node.attrs?.start;
      return { type: 'orderedList', ...(typeof start === 'number' && start !== 1 ? { attrs: { start } } : {}), content: (node.content ?? []).map(fromNode) };
    }
    case 'table': {
      const rows = node.content ?? [];
      const headerRow = !!rows[0]?.content?.length && rows[0].content.every(cell => cell.type === 'tableHeader');
      return { type: 'table', attrs: { headerRow, widths: node.attrs?.widths === 'equal' ? 'equal' : 'fit' }, content: rows.map((row, r) => row.type !== 'tableRow' ? row : {
        type: 'tableRow', content: (row.content ?? []).map(cell => {
          if (cell.type !== 'tableCell' && cell.type !== 'tableHeader') return cell;
          const span = Object.fromEntries((['colspan', 'rowspan'] as const).flatMap(key => cell.attrs?.[key] !== undefined && cell.attrs[key] !== 1 && cell.attrs[key] !== null ? [[key, cell.attrs[key]]] : []));
          return { type: headerRow && r === 0 ? 'tableHeader' : 'tableCell', ...(Object.keys(span).length ? { attrs: span } : {}), content: (cell.content ?? []).map(fromNode) };
        }),
      }) };
    }
    default: return node;
  }
}

export function editorJsonToEmailBody(json: EditorJson): EmailBodyDoc {
  if (json.type !== 'doc') return json as unknown as EmailBodyDoc;
  const content = (json.content ?? []).map(fromNode);
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] } as EmailBodyDoc;
}

export function emailBodyToEditorJson(doc: EmailBodyDoc): EditorJson {
  const to = (node: unknown): EditorJson => {
    const item = node as EditorJson;
    if (item.type === 'table') return { type: 'table', attrs: { widths: item.attrs?.widths ?? 'fit' }, content: (item.content ?? []).map(to) };
    if (item.type === 'tableCell' || item.type === 'tableHeader') return { type: item.type, content: (item.content ?? []).map(to) };
    return item.content ? { ...item, content: item.content.map(to) } : item;
  };
  return to(doc);
}
