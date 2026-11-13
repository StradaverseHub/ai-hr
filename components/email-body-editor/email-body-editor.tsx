'use client';
import { useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { Bold, Braces, Image as ImageIcon, Italic, Link2, List, ListOrdered, Redo2, Table2, Underline, Undo2 } from 'lucide-react';
import { EMAIL_TABLE_MAX_COLUMNS, EMAIL_TABLE_MAX_ROWS, EMAIL_TABLE_WARN_COLUMNS, validateEmailLink, type EmailBodyDoc, type EmailLinkKind, type EmailTableCellLocation } from '@/lib/email-body/doc';
import { editorJsonToEmailBody, emailBodyToEditorJson, type EditorJson } from '@/lib/email-body/editor-json';
import { cleanEmailPaste } from './paste-clean';
import { emailBodyExtensions, emailTableContext, type EmailEditorHooks } from './extensions';
import { defaultEmailBodyEditorLabels, formatLabel, type EmailBodyEditorLabels } from './labels';

export type EmailBodyEditorField = { key: string; label: string };
export type EmailBodyEditorImage = { id: string; name: string; alt: string; src: string };
export type EmailBodyEditorDocument = { id: string; name: string; kind: string };
export type EmailBodyEditorHandle = { focus(): void; focusTableCell(location: EmailTableCellLocation): boolean; getEditor(): Editor | null };
export type EmailBodyEditorProps = {
  value: EmailBodyDoc;
  onChange: (doc: EmailBodyDoc) => void;
  disabled?: boolean;
  /** Fields the user may insert, already filtered of sensitive keys by the caller. */
  fields: readonly EmailBodyEditorField[];
  /** Uploaded images (src is a preview URL for the editor only). */
  images?: readonly EmailBodyEditorImage[];
  /** Documents that a "Document in this email" link may point to. */
  documents?: readonly EmailBodyEditorDocument[];
  /** Called after a document link is applied; the screen ticks the document and says so. */
  onDocumentLinked?: (documentId: string) => void;
  labels?: Partial<Omit<EmailBodyEditorLabels, 'linkErrors'>> & { linkErrors?: Partial<EmailBodyEditorLabels['linkErrors']> };
  'aria-label'?: string;
  'aria-describedby'?: string;
  id?: string;
  ref?: Ref<EmailBodyEditorHandle>;
};

type Panel = 'link' | 'table' | 'image' | 'field' | null;
type Notice = { text: string; tone: 'error' | 'warning' } | null;
type LinkDraft = { text: string; original: string; kind: EmailLinkKind; href: string; documentId: string; from: number; to: number; error: string; insecure: boolean };

const button = 'inline-flex min-h-9 min-w-9 items-center justify-center gap-1 rounded px-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-primary/15 aria-pressed:text-primary disabled:opacity-40';
const textButton = 'inline-flex min-h-9 items-center rounded border px-3 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary aria-pressed:bg-primary/10 disabled:opacity-40';
const input = 'block min-h-9 w-full rounded border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Roving tabindex: one tab stop per toolbar, arrows/Home/End move between enabled buttons. */
function rove(event: KeyboardEvent<HTMLElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-rove]:not(:disabled)'));
  if (!items.length) return;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
  event.preventDefault();
  items.forEach((item, index) => { item.tabIndex = index === next ? 0 : -1; });
  items[next].focus();
}
function Toolbar({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Exactly one tab stop: the first enabled button unless focus has moved one along.
  useEffect(() => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[data-rove]') ?? []);
    if (!items.some(item => item.tabIndex === 0 && !item.disabled)) { const first = items.find(item => !item.disabled); items.forEach(item => { item.tabIndex = item === first ? 0 : -1; }); }
  });
  return <div ref={ref} role="toolbar" aria-label={label} aria-orientation="horizontal" onKeyDown={rove} className={className}>{children}</div>;
}

export function EmailBodyEditor(props: EmailBodyEditorProps) {
  const { value, onChange, disabled = false, fields, images = [], documents = [], onDocumentLinked, ref } = props;
  const labels = useMemo<EmailBodyEditorLabels>(() => ({ ...defaultEmailBodyEditorLabels, ...props.labels, linkErrors: { ...defaultEmailBodyEditorLabels.linkErrors, ...props.labels?.linkErrors } }), [props.labels]);
  const baseId = useId(), id = props.id ?? `${baseId}-body`;
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [link, setLink] = useState<LinkDraft | null>(null);
  const [size, setSize] = useState({ columns: 2, rows: 2 });
  const [query, setQuery] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const emitted = useRef(JSON.stringify(value));
  const fieldMap = useMemo(() => new Map(fields.map(item => [item.key, item.label])), [fields]);
  const imageMap = useMemo(() => new Map(images.map(item => [item.id, item])), [images]);
  const documentMap = useMemo(() => new Map(documents.map(item => [item.id, item])), [documents]);
  // The editor and its extensions are created once; they read current props through this ref, refreshed after each render.
  const live = useRef({ onChange, onDocumentLinked, labels, fieldMap, imageMap, documentMap, openLink: () => {} });
  const [hooks] = useState<EmailEditorHooks>(() => ({
    fieldLabel: key => live.current.fieldMap.get(key), chipLabel: label => formatLabel(live.current.labels.fieldChip, { label }),
    image: assetId => { const found = live.current.imageMap.get(assetId); return found ? { src: found.src, alt: found.alt || found.name } : undefined; },
    documentName: documentId => live.current.documentMap.get(documentId)?.name,
    onLinkShortcut: () => live.current.openLink(), onNotice: () => setNotice({ text: live.current.labels.rowLimit, tone: 'error' }),
  }));
  const extensions = useMemo(() => emailBodyExtensions(hooks), [hooks]);

  const editor = useEditor({
    immediatelyRender: false, editable: !disabled, extensions, content: emailBodyToEditorJson(value),
    editorProps: {
      attributes: { id, role: 'textbox', 'aria-multiline': 'true', 'aria-label': props['aria-label'] ?? labels.editor, ...(props['aria-describedby'] ? { 'aria-describedby': props['aria-describedby'] } : {}),
        class: 'min-h-48 p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_table]:my-2 [&_table]:border-collapse [&_table[data-widths=equal]]:w-full [&_table[data-widths=equal]]:table-fixed [&_td]:border [&_td]:p-1.5 [&_td]:align-top [&_th]:border [&_th]:bg-muted [&_th]:p-1.5 [&_th]:text-left [&_th]:align-top [&_td_img]:max-w-16 [&_th_img]:max-w-16 [&_.selectedCell]:bg-primary/10 [&_.ProseMirror-selectednode]:ring-2 [&_.ProseMirror-selectednode]:ring-ring' },
      transformPastedHTML(html) {
        const { imageMap: imageIds, documentMap: documentIds, fieldMap: fieldKeys, labels: l } = live.current;
        const result = cleanEmailPaste(html, { imageIds: imageIds.keys(), documentIds: documentIds.keys(), fieldKeys: fieldKeys.keys() });
        const messages = [result.tooLarge && l.pasteTooLarge, result.truncated && l.pasteTruncated, result.droppedImages > 0 && l.pasteImages].filter(Boolean) as string[];
        if (messages.length) setNotice({ text: messages.join(' '), tone: 'warning' });
        return result.html;
      },
    },
    onUpdate({ editor: current }) {
      const doc = editorJsonToEmailBody(current.getJSON() as EditorJson);
      emitted.current = JSON.stringify(doc);
      live.current.onChange(doc);
    },
  });

  useEffect(() => { editor?.setEditable(!disabled); }, [editor, disabled]);
  // Controlled value: only an outside change (not our own echo) replaces the content.
  useEffect(() => {
    if (!editor) return;
    const json = JSON.stringify(value);
    if (json === emitted.current) return;
    emitted.current = json;
    editor.commands.setContent(emailBodyToEditorJson(value) as never, { emitUpdate: false });
  }, [editor, value]);

  const state = useEditorState({ editor, selector: ({ editor: current }) => current ? {
    bold: current.isActive('bold'), italic: current.isActive('italic'), underline: current.isActive('underline'), link: current.isActive('link'),
    linkAttrs: current.getAttributes('link') as { kind?: EmailLinkKind; href?: string | null; documentId?: string | null },
    bulletList: current.isActive('bulletList'), orderedList: current.isActive('orderedList'), inList: current.isActive('listItem'),
    table: emailTableContext(current.state), undo: current.can().undo(), redo: current.can().redo(), empty: current.state.selection.empty,
  } : null });

  useImperativeHandle(ref, () => ({
    focus: () => { editor?.commands.focus(); },
    getEditor: () => editor,
    focusTableCell: ({ table, row, column }) => {
      if (!editor) return false;
      let index = -1, target: number | null = null;
      editor.state.doc.forEach((node, offset) => {
        if (node.type.name !== 'table' || ++index !== table || row >= node.childCount) return;
        let pos = offset + 1;
        for (let r = 0; r < row; r++) pos += node.child(r).nodeSize;
        const tr = node.child(row);
        if (column >= tr.childCount) return;
        pos += 1;
        for (let c = 0; c < column; c++) pos += tr.child(c).nodeSize;
        target = pos + 2; // inside the cell's first paragraph
      });
      if (target === null) return false;
      editor.chain().focus().setTextSelection(target).scrollIntoView().run();
      return true;
    },
  }), [editor]);

  const close = (refocus = true) => { setPanel(null); setLink(null); setQuery(''); if (refocus) editor?.commands.focus(); };
  const toggle = (next: Exclude<Panel, null>) => { setNotice(null); if (panel === next) return close(); setPanel(next); setQuery(''); };
  useEffect(() => { if (panel) panelRef.current?.querySelector<HTMLElement>('input,select,button')?.focus(); }, [panel]);

  const leafText = (node: { type: { name: string }; attrs: Record<string, unknown> }) => node.type.name === 'field' ? fieldMap.get(String(node.attrs.key)) ?? String(node.attrs.key) : node.type.name === 'hardBreak' ? ' ' : '';
  function openLink() {
    if (!editor || disabled) return;
    setNotice(null);
    let { from, to } = editor.state.selection;
    const attrs = editor.getAttributes('link') as { kind?: EmailLinkKind; href?: string | null; documentId?: string | null };
    if (editor.isActive('link')) { editor.chain().extendMarkRange('link').run(); ({ from, to } = editor.state.selection); }
    const text = editor.state.doc.textBetween(from, to, ' ', leafText as never);
    const kind = attrs.kind ?? 'web';
    setLink({ text, original: text, kind, href: kind === 'mailto' ? (attrs.href ?? '').replace(/^mailto:/i, '') : attrs.href ?? '', documentId: attrs.documentId ?? '', from, to, error: '', insecure: false });
    setPanel('link');
  }
  useLayoutEffect(() => { live.current = { onChange, onDocumentLinked, labels, fieldMap, imageMap, documentMap, openLink }; });

  function applyLink(force: boolean) {
    if (!editor || !link) return;
    const result = validateEmailLink({ kind: link.kind, ...(link.kind === 'document' ? { documentId: link.documentId } : { href: link.href }) }, { documentIds: documentMap.keys() });
    if (!result.ok) return setLink({ ...link, error: labels.linkErrors[result.error], insecure: false });
    if (result.warning === 'insecure' && !force) return setLink({ ...link, error: '', insecure: true });
    const attrs = { kind: result.kind, href: result.href ?? null, documentId: result.documentId ?? null };
    const shown = link.text.trim() ? link.text : result.kind === 'document' ? documentMap.get(result.documentId!)!.name : result.kind === 'mailto' ? result.href!.slice(7) : result.href!;
    const chain = editor.chain().focus();
    if (link.from === link.to || link.text !== link.original) chain.insertContentAt({ from: link.from, to: link.to }, { type: 'text', text: shown, marks: [{ type: 'link', attrs }] });
    else chain.setTextSelection({ from: link.from, to: link.to }).setMark('link', attrs);
    chain.run();
    if (result.kind === 'document') onDocumentLinked?.(result.documentId!);
    close();
  }
  const removeLink = () => editor?.chain().focus().extendMarkRange('link').unsetMark('link').run();
  const openTarget = () => { const href = state?.linkAttrs.href; if (href && state?.linkAttrs.kind !== 'document') window.open(href, '_blank', 'noopener,noreferrer'); };

  function insertTable(columns: number, rows: number) {
    if (!editor) return;
    if (state?.table || state?.inList) { setNotice({ text: labels.tablePlacement, tone: 'error' }); return close(); }
    editor.chain().focus().insertTable({ rows, cols: columns, withHeaderRow: true }).run();
    close(false);
    setNotice(columns >= EMAIL_TABLE_WARN_COLUMNS ? { text: labels.tablePhone, tone: 'warning' } : null);
  }
  function tableAction(action: 'rowAbove' | 'rowBelow' | 'columnLeft' | 'columnRight' | 'deleteRow' | 'deleteColumn' | 'headerRow' | 'fit' | 'equal' | 'deleteTable') {
    const context = editor && emailTableContext(editor.state);
    if (!editor || !context) return;
    const block = (text: string) => setNotice({ text, tone: 'error' });
    const chain = editor.chain().focus();
    setNotice(null);
    switch (action) {
      case 'rowAbove': if (context.headerRow && context.top === 0) return block(labels.blockedRowAboveHeader); if (context.rows >= EMAIL_TABLE_MAX_ROWS) return block(labels.rowLimit); chain.addRowBefore().run(); return;
      case 'rowBelow': if (context.rows >= EMAIL_TABLE_MAX_ROWS) return block(labels.rowLimit); chain.addRowAfter().run(); return;
      case 'columnLeft': case 'columnRight':
        if (context.columns >= EMAIL_TABLE_MAX_COLUMNS) return block(labels.columnLimit);
        (action === 'columnLeft' ? chain.addColumnBefore() : chain.addColumnAfter()).run();
        if (context.columns + 1 >= EMAIL_TABLE_WARN_COLUMNS) setNotice({ text: labels.tablePhone, tone: 'warning' });
        return;
      case 'deleteRow': if (context.headerRow && context.top === 0) return block(labels.blockedDeleteHeader); if (context.bottom - context.top >= context.rows) return block(labels.blockedLastRow); chain.deleteRow().run(); return;
      case 'deleteColumn': if (context.right - context.left >= context.columns) return block(labels.blockedLastColumn); chain.deleteColumn().run(); return;
      case 'headerRow': chain.toggleHeaderRow().run(); return;
      case 'fit': case 'equal': chain.command(({ tr }) => { const node = tr.doc.nodeAt(context.tablePos); if (!node) return false; tr.setNodeMarkup(context.tablePos, undefined, { ...node.attrs, widths: action }); return true; }).run(); return;
      case 'deleteTable': chain.deleteTable().run(); return;
    }
  }
  function insertImage(image: EmailBodyEditorImage) {
    if (!editor) return;
    if (state?.table && state.table.cellImages >= 1) { setNotice({ text: labels.imageCellLimit, tone: 'error' }); return close(); }
    editor.chain().focus().insertContent({ type: 'image', attrs: { assetId: image.id, alt: image.alt || image.name } }).run();
    close(false);
  }
  function insertField(key: string) {
    if (!editor) return;
    editor.chain().focus().insertContent({ type: 'field', attrs: { key } }).run();
    close(false);
  }
  const onPanelKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };

  const off = disabled || !editor;
  const tool = (key: string, label: string, icon: ReactNode, onClick: () => void, extra: { pressed?: boolean; disabled?: boolean; shortcut?: string; expanded?: boolean } = {}) =>
    <button key={key} type="button" data-rove="" data-tool={key} className={button} aria-label={label} title={extra.shortcut ? `${label} (${extra.shortcut})` : label}
      aria-keyshortcuts={extra.shortcut?.replace('Ctrl', 'Control')} aria-pressed={extra.pressed} aria-expanded={extra.expanded} aria-haspopup={extra.expanded === undefined ? undefined : 'dialog'}
      disabled={off || extra.disabled} onMouseDown={event => event.preventDefault()} onClick={onClick}>{icon}</button>;
  const separator = (key: string) => <span key={key} role="separator" aria-orientation="vertical" className="mx-1 h-6 w-px self-center bg-border" />;
  const table = state?.table;
  const term = query.trim().toLowerCase();
  const shownFields = fields.filter(item => `${item.label} ${item.key}`.toLowerCase().includes(term));

  return <div className="rounded-md border bg-background">
    <Toolbar label={labels.toolbar} className="flex flex-wrap items-center gap-0.5 border-b bg-muted/30 p-1">
      {tool('bold', labels.bold, <Bold aria-hidden size={16} />, () => editor?.chain().focus().toggleBold().run(), { pressed: state?.bold ?? false, shortcut: 'Ctrl+B' })}
      {tool('italic', labels.italic, <Italic aria-hidden size={16} />, () => editor?.chain().focus().toggleItalic().run(), { pressed: state?.italic ?? false, shortcut: 'Ctrl+I' })}
      {tool('underline', labels.underline, <Underline aria-hidden size={16} />, () => editor?.chain().focus().toggleUnderline().run(), { pressed: state?.underline ?? false, shortcut: 'Ctrl+U' })}
      {separator('s1')}
      {tool('link', labels.link, <Link2 aria-hidden size={16} />, () => panel === 'link' ? close() : openLink(), { pressed: state?.link ?? false, shortcut: 'Ctrl+K', expanded: panel === 'link' })}
      {separator('s2')}
      {tool('bulletList', labels.bulletList, <List aria-hidden size={16} />, () => editor?.chain().focus().toggleBulletList().run(), { pressed: state?.bulletList ?? false })}
      {tool('orderedList', labels.orderedList, <ListOrdered aria-hidden size={16} />, () => editor?.chain().focus().toggleOrderedList().run(), { pressed: state?.orderedList ?? false })}
      {separator('s3')}
      {tool('table', labels.table, <Table2 aria-hidden size={16} />, () => toggle('table'), { expanded: panel === 'table' })}
      {tool('image', labels.image, <ImageIcon aria-hidden size={16} />, () => toggle('image'), { expanded: panel === 'image' })}
      {tool('insertField', labels.insertField, <><Braces aria-hidden size={16} /><span className="hidden sm:inline">{labels.insertField}</span></>, () => toggle('field'), { expanded: panel === 'field' })}
      {separator('s4')}
      {tool('undo', labels.undo, <Undo2 aria-hidden size={16} />, () => editor?.chain().focus().undo().run(), { disabled: !state?.undo, shortcut: 'Ctrl+Z' })}
      {tool('redo', labels.redo, <Redo2 aria-hidden size={16} />, () => editor?.chain().focus().redo().run(), { disabled: !state?.redo, shortcut: 'Ctrl+Y' })}
    </Toolbar>

    {panel && <div ref={panelRef} role="dialog" aria-modal="false" aria-labelledby={`${baseId}-panel`} onKeyDown={onPanelKey} className="space-y-3 border-b bg-background p-3">
      <h3 id={`${baseId}-panel`} className="text-sm font-semibold">{{ link: labels.linkTitle, table: labels.tableTitle, image: labels.imageTitle, field: labels.fieldTitle }[panel]}</h3>
      {panel === 'link' && link && <form className="space-y-3" onSubmit={event => { event.preventDefault(); applyLink(false); }} noValidate>
        <label className="block space-y-1 text-sm"><span>{labels.textToShow}</span><input className={input} value={link.text} onChange={event => setLink({ ...link, text: event.target.value })} /></label>
        <fieldset className="space-y-1 text-sm"><legend>{labels.linkTo}</legend><div className="flex flex-wrap gap-3">
          {(['web', 'mailto', 'document'] as const).map(kind => <label key={kind} className="inline-flex items-center gap-1.5">
            <input type="radio" name={`${baseId}-kind`} value={kind} checked={link.kind === kind} onChange={() => setLink({ ...link, kind, error: '', insecure: false })} />
            {{ web: labels.linkWeb, mailto: labels.linkMailto, document: labels.linkDocument }[kind]}</label>)}
        </div></fieldset>
        {link.kind === 'document'
          ? documents.length ? <label className="block space-y-1 text-sm"><span>{labels.document}</span><select className={input} value={link.documentId} aria-invalid={!!link.error} aria-describedby={link.error ? `${baseId}-link-error` : undefined} onChange={event => setLink({ ...link, documentId: event.target.value, error: '' })}>
            <option value="">{labels.chooseDocument}</option>{documents.map(item => <option key={item.id} value={item.id}>{item.name} · {item.kind}</option>)}</select></label>
            : <p className="text-sm text-muted-foreground">{labels.noDocuments}</p>
          : <label className="block space-y-1 text-sm"><span>{link.kind === 'web' ? labels.webAddress : labels.emailAddress}</span><input className={input} inputMode={link.kind === 'web' ? 'url' : 'email'} value={link.href} aria-invalid={!!link.error}
            aria-describedby={link.error ? `${baseId}-link-error` : undefined} placeholder={link.kind === 'web' ? 'https://' : 'name@example.com'} onChange={event => setLink({ ...link, href: event.target.value, error: '', insecure: false })} /></label>}
        {link.error && <p id={`${baseId}-link-error`} role="alert" className="text-sm text-destructive">{link.error}</p>}
        {link.insecure && <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">{labels.insecure}</p>}
        <div className="flex flex-wrap gap-2">
          {link.insecure ? <button type="button" className={textButton} onClick={() => applyLink(true)}>{labels.applyAnyway}</button> : <button type="submit" className={textButton}>{labels.apply}</button>}
          <button type="button" className={textButton} onClick={() => close()}>{labels.cancel}</button>
        </div>
      </form>}
      {panel === 'table' && <div className="space-y-2">
        <div role="grid" aria-label={labels.tableTitle} className="inline-grid grid-cols-6 gap-1" onKeyDown={event => {
          const move = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[event.key];
          if (!move) return;
          event.preventDefault();
          const next = { columns: Math.min(EMAIL_TABLE_MAX_COLUMNS, Math.max(1, size.columns + move[0])), rows: Math.min(8, Math.max(1, size.rows + move[1])) };
          setSize(next);
          panelRef.current?.querySelector<HTMLButtonElement>(`[data-size="${next.columns}x${next.rows}"]`)?.focus();
        }}>
          {Array.from({ length: 8 }, (_, r) => <div role="row" key={r} className="contents">{Array.from({ length: EMAIL_TABLE_MAX_COLUMNS }, (_, c) => {
            const columns = c + 1, rows = r + 1, on = columns <= size.columns && rows <= size.rows;
            return <span role="gridcell" key={c}><button type="button" data-size={`${columns}x${rows}`} tabIndex={columns === size.columns && rows === size.rows ? 0 : -1}
              aria-label={formatLabel(labels.tableSize, { columns, rows })} onMouseEnter={() => setSize({ columns, rows })} onFocus={() => setSize({ columns, rows })} onClick={() => insertTable(columns, rows)}
              className={`block size-6 rounded-sm border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${on ? 'border-primary bg-primary/20' : 'bg-background'}`} /></span>;
          })}</div>)}
        </div>
        <p className="text-sm" aria-live="polite">{formatLabel(labels.tableSize, size)} · {labels.tableHint}</p>
        {size.columns >= EMAIL_TABLE_WARN_COLUMNS && <p className="text-sm text-amber-700 dark:text-amber-400">{labels.tablePhone}</p>}
      </div>}
      {panel === 'image' && (images.length ? <ul className="flex flex-wrap gap-2">{images.map(item => <li key={item.id}>
        <button type="button" className={`${textButton} gap-2 py-1`} onClick={() => insertImage(item)}>{item.src ? <>
          {/* eslint-disable-next-line @next/next/no-img-element -- uploaded template image preview (blob/authenticated URL), not a static asset */}
          <img src={item.src} alt="" className="size-8 rounded object-cover" /></> : null}<span>{item.name}</span><span className="text-muted-foreground">{item.alt || labels.noAlt}</span></button>
      </li>)}</ul> : <p className="text-sm text-muted-foreground">{labels.noImages}</p>)}
      {panel === 'field' && <div className="space-y-2">
        <input className={input} type="search" aria-label={labels.fieldSearch} placeholder={labels.fieldSearch} value={query} onChange={event => setQuery(event.target.value)} />
        {shownFields.length ? <ul className="max-h-56 space-y-0.5 overflow-auto">{shownFields.map(item => <li key={item.key}>
          <button type="button" className="flex w-full items-baseline justify-between gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => insertField(item.key)}>
            <span>{item.label}</span><code className="text-xs text-muted-foreground">{`{${item.key}}`}</code></button></li>)}</ul> : <p className="text-sm text-muted-foreground">{labels.noFields}</p>}
      </div>}
      <button type="button" className={textButton} onClick={() => close()}>{labels.close}</button>
    </div>}

    {state?.link && !panel && <div role="group" aria-label={labels.linkActions} className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-1.5 text-sm">
      <span className="min-w-0 flex-1 truncate">{formatLabel(labels.linkTarget, { target: state.linkAttrs.kind === 'document' ? formatLabel(labels.documentLinkTarget, { name: documentMap.get(state.linkAttrs.documentId ?? '')?.name ?? '' }) : String(state.linkAttrs.href ?? '').replace(/^mailto:/i, '') })}</span>
      <button type="button" className={textButton} disabled={state.linkAttrs.kind === 'document' || disabled} onClick={openTarget}>{labels.openLink}</button>
      <button type="button" className={textButton} disabled={disabled} onClick={openLink}>{labels.editLink}</button>
      <button type="button" className={textButton} disabled={disabled} onClick={removeLink}>{labels.removeLink}</button>
    </div>}

    {table && !disabled && <Toolbar label={labels.tableToolbar} className="flex flex-wrap items-center gap-1 border-b bg-muted/20 px-2 py-1.5">
      <span className="mr-1 text-sm font-medium" aria-live="polite">{formatLabel(labels.cellPosition, { row: table.top + 1, column: table.left + 1 })}</span>
      {(['rowAbove', 'rowBelow', 'columnLeft', 'columnRight', 'deleteRow', 'deleteColumn'] as const).map(action =>
        <button key={action} type="button" data-rove="" className={textButton} onMouseDown={event => event.preventDefault()} onClick={() => tableAction(action)}>{labels[action]}</button>)}
      <button type="button" data-rove="" className={textButton} aria-pressed={table.headerRow} onMouseDown={event => event.preventDefault()} onClick={() => tableAction('headerRow')}>{labels.headerRow}</button>
      <span role="group" aria-label={labels.widths} className="inline-flex gap-1">
        <button type="button" data-rove="" className={textButton} aria-pressed={table.widths === 'fit'} onMouseDown={event => event.preventDefault()} onClick={() => tableAction('fit')}>{labels.widthFit}</button>
        <button type="button" data-rove="" className={textButton} aria-pressed={table.widths === 'equal'} onMouseDown={event => event.preventDefault()} onClick={() => tableAction('equal')}>{labels.widthEqual}</button>
      </span>
      <button type="button" data-rove="" className={textButton} onMouseDown={event => event.preventDefault()} onClick={() => tableAction('deleteTable')}>{labels.deleteTable}</button>
    </Toolbar>}

    {notice && <p role={notice.tone === 'error' ? 'alert' : 'status'} className={`border-b px-3 py-1.5 text-sm ${notice.tone === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'}`}>{notice.text}</p>}
    <div className="max-h-[65vh] overflow-auto"><EditorContent editor={editor} /></div>
  </div>;
}
