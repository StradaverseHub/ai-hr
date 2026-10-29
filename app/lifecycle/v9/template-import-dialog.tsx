'use client';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { buildV9Import, parseV9ImportText, readV9ImportFile, type ParsedImport } from '@/lib/lifecycle-v9-import';
import type { Actor, Module, Template } from '@/lib/lifecycle-v9-model';

type Ready = ReturnType<typeof buildV9Import>;
export function TemplateImportDialog({ module: initialModule, actor, create, close }: { module: Module; actor: Actor; create: (template: Template) => void; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), sequence = useRef(0);
  const [module, setModule] = useState(initialModule), [type, setType] = useState<Template['type']>('Letter'), [name, setName] = useState(''), [pasted, setPasted] = useState('');
  const [filename, setFilename] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [ready, setReady] = useState<Ready | null>(null);
  useEffect(() => { dialog.current?.showModal(); return () => { sequence.current++; }; }, []);
  function invalidate() { sequence.current++; setBusy(false); setReady(null); setError(''); }
  async function read(operation: () => Promise<ParsedImport>, filename: string) {
    const token = ++sequence.current; setBusy(true); setReady(null); setError(''); setFilename(filename);
    try {
      const parsed = await operation(); if (token !== sequence.current) return;
      if (parsed.unreadable || !parsed.items.length) throw Error("The file has no readable text. Copy and paste the text below instead.");
      const result = buildV9Import(parsed, type, module, () => crypto.randomUUID());
      setReady(result); setName(current => current.trim() || filename.replace(/\.[a-z0-9]+$/i, '').slice(0, 80));
    } catch (error) { if (token === sequence.current) setError(error instanceof Error ? error.message : 'The file could not be read.'); }
    finally { if (token === sequence.current) setBusy(false); }
  }
  function finish() {
    if (!ready || busy) return;
    const { counts, matched, unmatched } = ready.report, today = todayInKualaLumpur();
    create({ id: crypto.randomUUID(), module, type, name: name.trim() || 'Imported document', rules: {}, hrStep: type === 'Letter' ? 'before' : 'none', employeeAck: type === 'Letter', retired: false,
      note: `Imported from "${filename}" on ${today} by ${actor.name}. ${counts.headings} headings, ${counts.paragraphs} paragraphs and ${counts.tables} tables came across; ${matched.length} placeholders became merge fields${unmatched.length ? `; left as text: ${unmatched.join(', ')}` : ''}. ${ready.notes.join(' ')}`,
      versions: [{ version: 1, state: 'draft', at: today, by: actor.name, blocks: ready.blocks, fields: [] }] });
    close();
  }
  return <dialog ref={dialog} className="v9-dialog" aria-labelledby="v9-import-title" onCancel={close}><header><h2 id="v9-import-title">Import a document</h2><button className="v9-button" type="button" aria-label="Close import" onClick={close}><X size={18}/></button></header><div className="v9-stack">
    <p className="v9-muted">Bring the content of an existing document into a new template, then edit it here.</p>
    <div className="v9-fields"><label className="v9-field">Module<select value={module} onChange={e => { invalidate(); setModule(e.target.value as Module); }}><option value="onb">Onboarding</option><option value="off">Offboarding</option></select></label><label className="v9-field">Type<select value={type} onChange={e => { invalidate(); setType(e.target.value as Template['type']); }}>{(['Form', 'Acknowledgement', 'Letter', 'Attachment'] as const).map(type => <option key={type}>{type}</option>)}</select></label></div>
    <label className="v9-field">Template name<input className="v9-input" maxLength={80} value={name} onChange={e => setName(e.target.value)}/></label>
    <label className="v9-field">Choose a file<input type="file" accept=".docx,.doc,.txt,.md,.markdown,.html,.htm,.pdf" disabled={busy} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void read(() => readV9ImportFile(file), file.name); }}/></label><p className="v9-muted">Word (.docx), text, Markdown, HTML or PDF · up to 10 MB</p>
    <label className="v9-field">Or paste the text<textarea rows={7} maxLength={60000} value={pasted} onChange={e => { setPasted(e.target.value); setReady(null); }}/></label><button type="button" className="v9-button" disabled={busy} onClick={() => { if (!pasted.trim()) { setError('Paste some text first.'); return; } void read(async () => parseV9ImportText(pasted), 'Pasted text'); }}>Use pasted text</button>
    {busy && <p role="status">Reading the file…</p>}{error && <p role="alert" className="v9-notice v9-error">{error}</p>}
    {ready && <section className="v9-panel v9-stack" aria-label="Ready to import"><h3>Ready to import</h3><p>{ready.report.counts.headings} headings · {ready.report.counts.paragraphs} paragraphs · {ready.report.counts.tables} {ready.report.counts.tables === 1 ? 'table' : 'tables'}</p>{ready.report.matched.length > 0 && <div><h3>Matched merge fields</h3><ul>{ready.report.matched.map(item => <li key={item.from}>{item.from} → {item.to}</li>)}</ul></div>}{ready.report.unmatched.length > 0 && <div><h3>Left as text</h3><ul>{ready.report.unmatched.map(text => <li key={text}>{text}</li>)}</ul></div>}<ul>{ready.notes.map((note, i) => <li key={i}>{note}</li>)}<li>Fonts, colours, spacing, headers, footers and images are not carried over.</li><li>{ready.report.signature ? 'A signature block was added at the end. Check it is where you want it.' : 'No signature block was added (attachments are sent as a PDF).'}</li><li>Blanks to fill in come across as plain text. Add form fields in the editor.</li></ul></section>}
    <div className="v9-actions"><button type="button" className="v9-button" onClick={close}>Cancel</button><button type="button" className="v9-button v9-button-primary" disabled={!ready || busy} onClick={finish}>Create draft template</button></div>
  </div></dialog>;
}
