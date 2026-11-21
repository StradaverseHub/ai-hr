import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EmailBodyEditor, type EmailBodyEditorHandle } from '../components/email-body-editor';
import { emailBodyDocSchema, type EmailBodyDoc, type EmailTable } from '../lib/email-body/doc';
import { legacyBodyToDoc } from '../lib/email-body/legacy';

// jsdom has no layout: ProseMirror's scrollIntoView asks for client rects. Empty rects are the honest stub here.
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
for (const proto of [Range.prototype, Element.prototype] as { getClientRects?: unknown; getBoundingClientRect?: unknown }[]) {
  proto.getClientRects ??= noRects;
  proto.getBoundingClientRect ??= () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} });
}

const fields = [{ key: 'employee.name', label: 'Full name' }, { key: 'company.name', label: 'Company' }];
const documents = [{ id: 'nda', name: 'Confidentiality agreement', kind: 'form' }];
const images = [{ id: 'img-1', name: 'logo.png', alt: 'Northwind logo', src: '' }];
const start = (text = 'Welcome aboard'): EmailBodyDoc => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function setup(value: EmailBodyDoc = start()) {
  const onChange = vi.fn(), onDocumentLinked = vi.fn(), handle = createRef<EmailBodyEditorHandle>();
  render(<EmailBodyEditor ref={handle} value={value} onChange={onChange} fields={fields} images={images} documents={documents} onDocumentLinked={onDocumentLinked} aria-label="Welcome email body" />);
  const box = await screen.findByRole('textbox', { name: 'Welcome email body' });
  await waitFor(() => expect(handle.current?.getEditor()).toBeTruthy());
  const editor = handle.current!.getEditor()!;
  const last = () => onChange.mock.lastCall![0] as EmailBodyDoc;
  const select = (from: number, to = from) => act(() => { editor.commands.setTextSelection({ from, to }); });
  return { box, editor, onChange, onDocumentLinked, handle, last, select };
}
const toolbar = () => screen.getByRole('toolbar', { name: 'Formatting' });
const tableOf = (doc: EmailBodyDoc) => doc.content.find((block): block is EmailTable => block.type === 'table')!;

describe('EmailBodyEditor', () => {
  it('shows the toolbar in the agreed order with a single tab stop and arrow-key movement', async () => {
    await setup();
    const buttons = within(toolbar()).getAllByRole('button');
    expect(buttons.map(item => item.getAttribute('aria-label'))).toEqual(['Bold', 'Italic', 'Underline', 'Link', 'Bulleted list', 'Numbered list', 'Table', 'Image', 'Insert field', 'Undo', 'Redo']);
    expect(within(toolbar()).getAllByRole('separator')).toHaveLength(4);
    await waitFor(() => expect(buttons.filter(item => item.tabIndex === 0)).toEqual([buttons[0]]));
    buttons[0].focus();
    fireEvent.keyDown(buttons[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(buttons[1], { key: 'End' });
    expect(document.activeElement).toBe(buttons[8]); // Undo/Redo are disabled with no history
  });

  it('applies bold with Ctrl+B and emits schema-valid EmailBodyDoc JSON', async () => {
    const { box, last, select } = await setup();
    select(1, 8);
    fireEvent.keyDown(box, { key: 'b', ctrlKey: true });
    await waitFor(() => expect(last().content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Welcome', marks: [{ type: 'bold' }] }, { type: 'text', text: ' aboard' }] }));
    expect(emailBodyDocSchema.safeParse(last()).success).toBe(true);
    expect(within(toolbar()).getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('inserts a field chip with a readable label and code on hover, and deletes it as one piece', async () => {
    const { box, editor, last, select } = await setup();
    select(8);
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Insert field' }));
    const panel = screen.getByRole('dialog', { name: 'Insert field' });
    fireEvent.change(within(panel).getByRole('searchbox', { name: 'Search fields' }), { target: { value: 'full' } });
    fireEvent.click(within(panel).getByRole('button', { name: /Full name/ }));
    await waitFor(() => expect(last().content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Welcome' }, { type: 'field', attrs: { key: 'employee.name' } }, { type: 'text', text: ' aboard' }] }));
    const chip = box.querySelector('[data-email-field="employee.name"]')!;
    expect(chip.textContent).toBe('Full name');
    expect(chip).toHaveAttribute('title', '{employee.name}');
    expect(chip).toHaveAttribute('contenteditable', 'false');
    expect(editor.state.selection.from).toBe(9);
    fireEvent.keyDown(box, { key: 'Backspace' });
    await waitFor(() => expect(last().content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Welcome aboard' }] }));
  });

  it('validates links: blocks javascript:, warns on http with Apply anyway, adds https:// otherwise', async () => {
    const { box, last, select } = await setup();
    select(1, 8);
    fireEvent.keyDown(box, { key: 'k', ctrlKey: true });
    const panel = screen.getByRole('dialog', { name: 'Link' });
    expect(within(panel).getByRole('textbox', { name: 'Text to show' })).toHaveValue('Welcome');
    expect(within(panel).getByRole('radio', { name: 'Web address' })).toBeChecked();
    const address = within(panel).getByRole('textbox', { name: 'Web address' });
    fireEvent.change(address, { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(within(panel).getByRole('alert')).toHaveTextContent('Only web (https:// or http://) and email addresses can be linked.');
    fireEvent.change(address, { target: { value: 'https://portal.example.test/{employee.name}' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(within(panel).getByRole('alert')).toHaveTextContent('Fields cannot be used in a link address.');
    fireEvent.change(address, { target: { value: 'http://legacy.example.test' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(within(panel).getByRole('alert')).toHaveTextContent('not secure');
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply anyway' }));
    await waitFor(() => expect(last().content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Welcome', marks: [{ type: 'link', attrs: { kind: 'web', href: 'http://legacy.example.test' } }] }, { type: 'text', text: ' aboard' }] }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Cursor inside the link offers Open, Edit, Remove; Remove keeps the text.
    select(3);
    const actions = await screen.findByRole('group', { name: 'Link' });
    expect(within(actions).getAllByRole('button').map(item => item.textContent)).toEqual(['Open', 'Edit', 'Remove']);
    fireEvent.click(within(actions).getByRole('button', { name: 'Edit' }));
    const edit = screen.getByRole('dialog', { name: 'Link' });
    fireEvent.change(within(edit).getByRole('textbox', { name: 'Web address' }), { target: { value: 'portal.example.test' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(last().content[0]).toMatchObject({ content: [{ text: 'Welcome', marks: [{ type: 'link', attrs: { kind: 'web', href: 'https://portal.example.test' } }] }, { text: ' aboard' }] }));
    select(3);
    fireEvent.click(within(await screen.findByRole('group', { name: 'Link' })).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(last().content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Welcome aboard' }] }));
  });

  it('links a document in this email and tells the screen so it can tick it', async () => {
    const { last, select, onDocumentLinked } = await setup();
    select(15);
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Link' }));
    const panel = screen.getByRole('dialog', { name: 'Link' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Document in this email' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(within(panel).getByRole('alert')).toHaveTextContent('Choose a document from this email.');
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Document' }), { target: { value: 'nda' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(last().content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Welcome aboard' }, { type: 'text', text: 'Confidentiality agreement', marks: [{ type: 'link', attrs: { kind: 'document', documentId: 'nda' } }] }] }));
    expect(onDocumentLinked).toHaveBeenCalledWith('nda');
  });

  it('inserts a table with a header row, adds a row on Tab in the last cell and blocks breaking actions', async () => {
    const { box, editor, last, select } = await setup();
    select(15);
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Table' }));
    const picker = screen.getByRole('dialog', { name: 'Insert table' });
    fireEvent.click(within(picker).getByRole('button', { name: '2 columns × 2 rows' }));
    await waitFor(() => expect(tableOf(last())).toBeTruthy());
    expect(tableOf(last()).attrs).toEqual({ headerRow: true, widths: 'fit' });
    expect(tableOf(last()).content[0].content.map(cell => cell.type)).toEqual(['tableHeader', 'tableHeader']);
    const tableBar = screen.getByRole('toolbar', { name: 'Table' });
    expect(tableBar).toHaveTextContent('Row 1, column 1');
    fireEvent.click(within(tableBar).getByRole('button', { name: 'Delete row' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The header row cannot be deleted. Turn Header row off instead.');
    fireEvent.click(within(tableBar).getByRole('button', { name: 'Row above' }));
    expect(screen.getByRole('alert')).toHaveTextContent('A row cannot be added above the header row.');
    expect(tableOf(last()).content).toHaveLength(2);
    for (let i = 0; i < 3; i++) fireEvent.keyDown(box, { key: 'Tab' });
    expect(screen.getByRole('toolbar', { name: 'Table' })).toHaveTextContent('Row 2, column 2');
    fireEvent.keyDown(box, { key: 'Tab' });
    await waitFor(() => expect(tableOf(last()).content).toHaveLength(3));
    expect(screen.getByRole('toolbar', { name: 'Table' })).toHaveTextContent('Row 3, column 1');
    fireEvent.keyDown(box, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('toolbar', { name: 'Table' })).toHaveTextContent('Row 2, column 2');
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Table' })).getByRole('button', { name: 'Equal' }));
    await waitFor(() => expect(tableOf(last()).attrs.widths).toBe('equal'));
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Table' })).getByRole('button', { name: 'Delete column' }));
    await waitFor(() => expect(tableOf(last()).content[0].content).toHaveLength(1));
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Table' })).getByRole('button', { name: 'Delete column' }));
    expect(screen.getByRole('alert')).toHaveTextContent('This is the last column. Use Delete table instead.');
    expect(emailBodyDocSchema.safeParse(last()).success).toBe(true);
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Table' })).getByRole('button', { name: 'Delete table' }));
    await waitFor(() => expect(last().content.some(block => block.type === 'table')).toBe(false));
    act(() => { editor.commands.undo(); });
    await waitFor(() => expect(last().content.some(block => block.type === 'table')).toBe(true));
  });

  it('inserts one image per table cell and warns about wide tables', async () => {
    const { last, select } = await setup();
    select(15);
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Table' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Insert table' })).getByRole('button', { name: '5 columns × 2 rows' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Tables with 5 or more columns are hard to read on phones.');
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Image' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Insert image' })).getByRole('button', { name: /logo\.png/ }));
    await waitFor(() => expect(JSON.stringify(tableOf(last()))).toContain('"assetId":"img-1"'));
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Image' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Insert image' })).getByRole('button', { name: /logo\.png/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('A table cell can hold one image.');
    expect(JSON.stringify(last()).match(/img-1/g)).toHaveLength(1);
  });

  it('opens a legacy body losslessly and focuses an empty cell for Show me', async () => {
    const legacy = legacyBodyToDoc('Dear {employee.name},\n\nLine one\nLine two {image:img-1}');
    const table: EmailTable = { type: 'table', attrs: { headerRow: true, widths: 'fit' }, content: [
      { type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'System' }] }] }] },
      { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph' }] }] },
    ] };
    const { box, handle, editor } = await setup({ type: 'doc', content: [...legacyBodyToDoc('Dear {employee.name},\n\nLine one\nLine two {image:img-1}', images).content, table] });
    expect(legacy.content).toHaveLength(2);
    expect(box.querySelector('[data-email-field="employee.name"]')?.textContent).toBe('Full name');
    expect(box.querySelector('img[data-email-image="img-1"]')).toHaveAttribute('alt', 'Northwind logo');
    expect(box.querySelectorAll('br').length).toBeGreaterThan(0);
    act(() => { expect(handle.current!.focusTableCell({ table: 0, row: 1, column: 0 })).toBe(true); });
    expect(screen.getByRole('toolbar', { name: 'Table' })).toHaveTextContent('Row 2, column 1');
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
  });

  it('cleans pasted Word HTML into allowed content and truncates an oversize pasted table with a warning', async () => {
    const { box, last, select } = await setup();
    select(15);
    const rows = Array.from({ length: 40 }, (_, r) => `<tr>${Array.from({ length: 8 }, (_, c) => `<td style="color:red">r${r}c${c}</td>`).join('')}</tr>`).join('');
    const html = `<p class="MsoNormal" style="font-family:Calibri;color:#ff0000"><b>Bold</b> <span style="background:yellow">plain</span><img src="file:///C:/x.png"><o:p></o:p></p><table class="MsoTableGrid">${rows}</table>`;
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    paste.clipboardData = { types: ['text/html', 'text/plain'], getData: (type: string) => type === 'text/html' ? html : type === 'text/plain' ? 'Bold plain' : '' };
    act(() => { box.dispatchEvent(paste); });
    await waitFor(() => expect(tableOf(last())).toBeTruthy());
    const table = tableOf(last());
    expect(table.content).toHaveLength(30);
    expect(table.content.every(row => row.content.length === 6)).toBe(true);
    expect(emailBodyDocSchema.safeParse(last()).success).toBe(true);
    expect(JSON.stringify(last())).toContain('{"type":"text","text":"Bold","marks":[{"type":"bold"}]}');
    expect(JSON.stringify(last())).not.toMatch(/Calibri|color|yellow|image/);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Only the first 6 columns and 30 rows were kept.');
    expect(status).toHaveTextContent('Pasted images were removed.');
  });

  it('is read-only and its toolbar is disabled when disabled', async () => {
    render(<EmailBodyEditor value={start()} onChange={() => {}} fields={fields} disabled />);
    await screen.findByRole('textbox', { name: 'Email body' });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Email body' })).toHaveAttribute('contenteditable', 'false'));
    expect(within(toolbar()).getAllByRole('button').every(item => (item as HTMLButtonElement).disabled)).toBe(true);
  });
});
