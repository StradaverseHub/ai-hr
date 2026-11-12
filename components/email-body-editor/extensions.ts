import { Extension, Mark, Node, mergeAttributes, type Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { isInTable, selectedRect } from '@tiptap/pm/tables';
import type { EditorState } from '@tiptap/pm/state';
import { EMAIL_TABLE_MAX_ROWS } from '@/lib/email-body/doc';
import { safePastedLink } from '@/lib/email-body/paste';

/** Live lookups the extensions read at render/parse time. The component keeps one mutable object current with its props. */
export type EmailEditorHooks = {
  fieldLabel: (key: string) => string | undefined;
  chipLabel: (label: string) => string;
  image: (assetId: string) => { src?: string; alt?: string } | undefined;
  documentName: (documentId: string) => string | undefined;
  onLinkShortcut: () => void;
  onNotice: (key: 'rowLimit') => void;
};

export type EmailTableContext = { top: number; bottom: number; left: number; right: number; rows: number; columns: number; headerRow: boolean; widths: 'fit' | 'equal'; tablePos: number; cellImages: number };

/** Where the selection sits in a table (rows/columns of the selected rectangle), or null outside tables. */
export function emailTableContext(state: EditorState): EmailTableContext | null {
  if (!isInTable(state)) return null;
  const rect = selectedRect(state), first = rect.table.firstChild;
  let cellImages = 0;
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') { node.descendants(child => { if (child.type.name === 'image') cellImages++; }); break; }
  }
  const headerRow = !!first && first.childCount > 0 && Array.from({ length: first.childCount }, (_, index) => first.child(index)).every(cell => cell.type.name === 'tableHeader');
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, rows: rect.map.height, columns: rect.map.width, headerRow,
    widths: rect.table.attrs.widths === 'equal' ? 'equal' : 'fit', tablePos: rect.tableStart - 1, cellImages };
}

const deleteAtom = (editor: Editor, name: string, direction: -1 | 1) => {
  const { selection } = editor.state;
  if (!selection.empty) return false;
  const node = direction < 0 ? selection.$from.nodeBefore : selection.$from.nodeAfter;
  if (node?.type.name !== name) return false;
  const from = direction < 0 ? selection.from - node.nodeSize : selection.from;
  return editor.commands.deleteRange({ from, to: from + node.nodeSize });
};

export function emailBodyExtensions(hooks: EmailEditorHooks) {
  // Tables live in their own group so they can only sit at the top level: never in a list item or a cell.
  const doc = Node.create({ name: 'doc', topNode: true, content: '(block | emailTable)+' });

  const field = Node.create({
    name: 'field', group: 'inline', inline: true, atom: true, selectable: true, draggable: false,
    addAttributes() { return { key: { default: '', parseHTML: element => element.getAttribute('data-email-field') ?? '', renderHTML: () => ({}) } }; },
    parseHTML() { return [{ tag: 'span[data-email-field]', getAttrs: element => hooks.fieldLabel((element as HTMLElement).getAttribute('data-email-field') ?? '') ? null : false }]; },
    renderHTML({ node, HTMLAttributes }) {
      const key = String(node.attrs.key), label = hooks.fieldLabel(key) ?? key;
      return ['span', mergeAttributes(HTMLAttributes, { 'data-email-field': key, contenteditable: 'false', title: `{${key}}`, 'aria-label': hooks.chipLabel(label), class: 'email-body-chip mx-px inline-block rounded bg-primary/10 px-1 font-medium text-primary' }), label];
    },
    renderText({ node }) { return `{${node.attrs.key}}`; },
    // A chip is one piece: Backspace/Delete next to it removes the whole chip (not left to the browser).
    addKeyboardShortcuts() { return { Backspace: () => deleteAtom(this.editor, 'field', -1), Delete: () => deleteAtom(this.editor, 'field', 1) }; },
  });

  const image = Node.create({
    name: 'image', group: 'inline', inline: true, atom: true, selectable: true, draggable: false,
    addAttributes() { return { assetId: { default: '', parseHTML: element => element.getAttribute('data-email-image') ?? '', renderHTML: () => ({}) }, alt: { default: '', parseHTML: element => element.getAttribute('alt') ?? '', renderHTML: () => ({}) } }; },
    parseHTML() { return [{ tag: 'img[data-email-image]', getAttrs: element => hooks.image((element as HTMLElement).getAttribute('data-email-image') ?? '') ? null : false }]; },
    renderHTML({ node }) {
      const found = hooks.image(String(node.attrs.assetId));
      return ['img', { 'data-email-image': node.attrs.assetId, alt: found?.alt || node.attrs.alt, src: found?.src ?? '', class: 'email-body-image inline-block h-auto max-w-full align-middle' }];
    },
    renderText({ node }) { return `[${node.attrs.alt}]`; },
    addKeyboardShortcuts() { return { Backspace: () => deleteAtom(this.editor, 'image', -1), Delete: () => deleteAtom(this.editor, 'image', 1) }; },
  });

  const link = Mark.create({
    name: 'link', inclusive: false, priority: 1000,
    addAttributes() { return { kind: { default: 'web', renderHTML: () => ({}) }, href: { default: null, renderHTML: () => ({}) }, documentId: { default: null, renderHTML: () => ({}) } }; },
    parseHTML() {
      return [
        { tag: 'a[data-email-document]', priority: 60, getAttrs: element => { const id = (element as HTMLElement).getAttribute('data-email-document') ?? ''; return hooks.documentName(id) ? { kind: 'document', documentId: id, href: null } : false; } },
        { tag: 'a[href]', getAttrs: element => { const safe = safePastedLink((element as HTMLElement).getAttribute('href')); return safe ? { kind: safe.kind, href: safe.href, documentId: null } : false; } },
      ];
    },
    renderHTML({ mark }) {
      const { kind, href, documentId } = mark.attrs as { kind: string; href: string | null; documentId: string | null };
      const attrs = kind === 'document'
        ? { 'data-email-link': 'document', 'data-email-document': documentId, title: hooks.documentName(documentId ?? '') ?? documentId }
        : { 'data-email-link': kind, href, title: href, target: '_blank', rel: 'noopener noreferrer' };
      return ['a', { ...attrs, class: 'email-body-link text-primary underline [overflow-wrap:anywhere]' }, 0];
    },
  });

  const table = Table.extend({
    group: 'emailTable',
    addAttributes() { return { ...this.parent?.(), widths: { default: 'fit', parseHTML: element => element.getAttribute('data-widths') === 'equal' ? 'equal' : 'fit', renderHTML: attributes => ({ 'data-widths': attributes.widths }) } }; },
  }).configure({ resizable: false, allowTableNodeSelection: false });

  const keys = Extension.create({
    name: 'emailBodyKeys', priority: 1100,
    addKeyboardShortcuts() {
      return {
        'Mod-k': () => { hooks.onLinkShortcut(); return true; },
        Tab: () => {
          const context = emailTableContext(this.editor.state);
          if (!context) return false;
          if (this.editor.commands.goToNextCell()) return true;
          if (context.rows >= EMAIL_TABLE_MAX_ROWS) { hooks.onNotice('rowLimit'); return true; }
          return this.editor.chain().addRowAfter().goToNextCell().run();
        },
        'Shift-Tab': () => !!emailTableContext(this.editor.state) && (this.editor.commands.goToPreviousCell() || true),
      };
    },
  });

  return [
    StarterKit.configure({ document: false, blockquote: false, code: false, codeBlock: false, heading: false, horizontalRule: false, strike: false, link: false, trailingNode: false }),
    doc, field, image, link, table, TableRow, TableHeader, TableCell, keys,
  ];
}
