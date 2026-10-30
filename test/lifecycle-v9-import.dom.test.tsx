import { beforeAll, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import JSZip from 'jszip';
import { buildV9Import, parseV9ImportHtml, parseV9ImportText, readV9ImportFile } from '../lib/lifecycle-v9-import';
import { TemplateImportDialog } from '../app/lifecycle/v9/template-import-dialog';
import { parseV9Config } from '../lib/lifecycle-v9-validation';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); }; });
it('converts known placeholders while preserving unmatched text and table structure', () => {
  const parsed = parseV9ImportText('# Acceptance\n\nDear [Employee Name],\nYour last day is {{Last working day}}. [Unknown Field]\n\n| Item | Due |\n| --- | --- |\n| Laptop | ${lastday} |\n\nYours sincerely,');
  let id = 0; const result = buildV9Import(parsed, 'Letter', 'off', () => `block-${++id}`);
  expect(result.report.counts).toEqual({ headings: 1, paragraphs: 1, tables: 1 });
  expect(result.report.matched.map(m => m.to)).toEqual(['{employee.name}', '{leaver.lastDay}', '{leaver.lastDay}']);
  expect(result.report.unmatched).toEqual(['[Unknown Field]']);
  expect(result.blocks.find(b => b.type === 'text')!.text).toContain('Dear {employee.name}');
  expect(result.blocks.find(b => b.type === 'table')).toMatchObject({ columns: 'Item, Due', rows: 'Laptop | {leaver.lastDay}' });
  expect(result.blocks.at(-1)).toMatchObject({ type: 'signature', role: 'hr' });
  expect(buildV9Import(parsed, 'Attachment', 'off', () => `a-${++id}`).blocks.some(b => b.type === 'signature')).toBe(false);
});
it('imports HTML as plain content without executing or retaining remote markup', () => {
  const parsed = parseV9ImportHtml('<script>stealSecrets()</script><style>body{color:red}</style><h1>Welcome</h1><p>Hello <b>[Employee Name]</b><img src="https://example.invalid/private"></p><iframe src="https://example.invalid"></iframe>');
  expect(parsed.items).toEqual([{ kind: 'heading', text: 'Welcome' }, { kind: 'text', text: 'Hello [Employee Name]' }]);
});
it('reads Word headings and tables locally and refuses unsupported files and oversized XML', async () => {
  const zip = new JSZip(); zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Exit review</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
  const file = async (name: string) => { const bytes = await zip.generateAsync({ type: 'arraybuffer' }); return { name, size: bytes.byteLength, arrayBuffer: async () => bytes } as File; };
  expect((await readV9ImportFile(await file('review.docx'))).items).toEqual([{ kind: 'heading', text: 'Exit review' }, { kind: 'table', rows: [['Item']] }]);
  await expect(readV9ImportFile(await file('review.doc'))).rejects.toThrow('save it as .docx');
  zip.file('word/document.xml', '<!DOCTYPE document><document/>');
  await expect(readV9ImportFile(await file('unsafe.docx'))).rejects.toThrow('unsupported XML');
  zip.file('word/document.xml', 'a'.repeat(2_000_001));
  await expect(readV9ImportFile(await file('large.docx'))).rejects.toThrow('too large');
});
it('reviews pasted content and creates a separate unpublished draft with the actual actor', async () => {
  const create = vi.fn(), close = vi.fn();
  render(<TemplateImportDialog module="off" actor={{ id: 'actual-user', name: 'Fixture HR' }} create={create} close={close}/>);
  expect(screen.getByRole('button', { name: 'Create draft template' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Or paste the text'), { target: { value: '# Exit letter\n\nDear [Employee Name],\nThank you.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use pasted text' }));
  expect(await screen.findByRole('region', { name: 'Ready to import' })).toHaveTextContent('[Employee Name] → {employee.name}');
  fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Imported exit letter' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create draft template' }));
  const template = create.mock.calls[0][0], config = v9Defaults(), prior = structuredClone(config.templates);
  config.templates.push(template);
  expect(() => parseV9Config(config)).not.toThrow();
  expect(config.templates.slice(0, -1)).toEqual(prior);
  expect(template).toMatchObject({ name: 'Imported exit letter', module: 'off', hrStep: 'before', employeeAck: true, versions: [{ version: 1, state: 'draft', by: 'Fixture HR' }] });
  expect(template.note).toContain('Imported from "Pasted text"'); expect(close).toHaveBeenCalledOnce();
});
