'use client';
import { useRef, useState, type ReactNode } from 'react';
import { personnelMergeGroups, personnelMergeLabels } from '@/lib/lifecycle-v9-personnel-merge-fields';
import { DocumentBody } from '@/components/lifecycle-v9/document-body';
import { merge, personnelFieldSourceValue } from '@/lib/lifecycle-v9-model';
import type { Block, Document, Field, TemplateVersion } from '@/lib/lifecycle-v9-model';

function Input({ label, children }: { label: string; children: ReactNode }) { return <label className="v9-field"><span>{label}</span>{children}</label>; }
function Button({ children, disabled, click }: { children: ReactNode; disabled?: boolean; click: () => void }) { return <button type="button" className="v9-button" disabled={disabled} onClick={click}>{children}</button>; }
const defaultLabels = {"newField": "New field", "version": "Template version", "content": "Content", "fields": "Fields", "preview": "Preview", "fieldForBlock": "Field for block {n}", "choose": "Choose…", "sectionForBlock": "Section for block {n}", "columnsForBlock": "Columns for block {n}", "rowsForBlock": "Rows for block {n}", "columnPlaceholder": "Name | Description", "rowsPlaceholder": "One row per line; separate cells with |", "signatureLabel": "Signature label {n}", "signer": "Signer {n}", "employee": "Employee", "hr": "HR", "up": "Move block {n} up", "down": "Move block {n} down", "removeBlock": "Remove block {n}", "addBlock": "Add block", "chooseBlock": "Choose a block…", "employeeSignature": "Employee signature", "ownershipHelp": "Personnel locked fields are read-only. Employee and HR fields are completed by their named owner. Corrections to Personnel require HR review before they are applied.", "fieldLabel": "Field {n} label", "fieldType": "Field {n} type", "fieldOwner": "Field {n} completed by", "locked": "Personnel locked", "fieldWidth": "Field {n} width", "full": "Full width", "half": "Half width", "fieldSection": "Field {n} section", "fieldPersonnel": "Field {n} Personnel field", "required": "Required", "sensitive": "Sensitive", "fieldOptions": "Field {n} options", "fieldColumns": "Field {n} columns", "fieldWhen": "Field {n} show when", "always": "Always show", "fieldEquals": "Field {n} equals", "removeField": "Remove field {n}", "addField": "Add field", "letterhead": "Letterhead", "heading": "Heading", "subheading": "Subheading", "text": "Text", "fieldSectionBlock": "Field section", "formField": "Form field", "table": "Table", "signature": "Signature", "typeText": "text", "typeTextarea": "textarea", "typeSelect": "select", "typeDate": "date", "typeCheckbox": "checkbox", "typePhone": "phone", "typeEmail": "email", "typeNumber": "number", "typeTable": "table"};
export type TemplateEditorLabels=typeof defaultLabels;
export function TemplateVersionEditor({ version, name, disabled, change,labels=defaultLabels,fieldOwners=['employee','hr','pmLocked'],defaultFieldOwner='employee',previewValues, previewCases = [], loadPreview, personnelPicker = false }: { labels?:TemplateEditorLabels;fieldOwners?:Field['owner'][];defaultFieldOwner?:Field['owner'];previewValues?:Record<string,string>;previewCases?:{id:string;label:string}[];loadPreview?:(id:string)=>Promise<{ok:true;values:Record<string,string>}|{ok:false;error:string}>;personnelPicker?:boolean;version: TemplateVersion; name: string; disabled: boolean; change: (change: (version: TemplateVersion) => void) => void }) {
  const l=(key:keyof TemplateEditorLabels,n?:number)=>labels[key].replace('{n}',String(n??''));
  const blockNames:Record<Block['type'],string>={letterhead:l('letterhead'),heading:l('heading'),subheading:l('subheading'),text:l('text'),fields:l('fieldSectionBlock'),field:l('formField'),table:l('table'),signature:l('signature')};
  const [tab, setTab] = useState<'content' | 'fields' | 'preview'>('content');
  const selection = useRef<{ blockId: string; node: HTMLTextAreaElement } | null>(null);
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [previewCase, setPreviewCase] = useState('');
  const [loadedValues, setLoadedValues] = useState<Record<string, string>>();
  const [previewError, setPreviewError] = useState('');
  const previewRequest = useRef(0);
  async function choosePreview(id: string) {
    const request = ++previewRequest.current;
    setPreviewCase(id);
    setLoadedValues(undefined);
    setPreviewError('');
    if (!id || !loadPreview) return;
    const result = await loadPreview(id);
    if (request !== previewRequest.current) return;
    if (result.ok) setLoadedValues(result.values);
    else setPreviewError(result.error);
  }
  const effectivePreviewValues = loadedValues ?? previewValues;
  const selectedIndex = () => version.blocks.findIndex(block => block.id === selection.current?.blockId);
  function insertMergeField(key: string, label: string) {
    const index = selectedIndex();
    if (index < 0 || !selection.current?.node.isConnected) {
      setMessage('Click into a text block first');
      return;
    }
    const { node } = selection.current;
    const start = node.selectionStart;
    const token = '{' + key + '}';
    updateBlock(index, { text: node.value.slice(0, start) + token + node.value.slice(node.selectionEnd) });
    setMessage(label + ' inserted into the selected text block');
    requestAnimationFrame(() => {
      node.focus();
      node.setSelectionRange(start + token.length, start + token.length);
    });
  }
  function addMergeField(field: (typeof personnelMergeGroups)[number]['fields'][number]) {
    const index = selectedIndex();
    change(v => {
      const id = crypto.randomUUID();
      const section = v.blocks[index]?.section ?? 'main';
      v.fields.push({ id, label: field.label, type: field.type ?? 'text', owner: 'pmLocked', pmKey: field.key, required: false, sensitive: false, options: [], section, width: 'full', columns: [], when: null });
      v.blocks.splice(index < 0 ? v.blocks.length : index + 1, 0, { id: crypto.randomUUID(), type: 'field', fieldId: id, text: '', section });
    });
    setMessage(field.label + ' added as a pre-filled field');
  }
  const updateBlock = (index: number, patch: Partial<Block>) => change(v => { Object.assign(v.blocks[index], patch); });
  const updateField = (index: number, patch: Partial<Field>) => change(v => { Object.assign(v.fields[index], patch); });
  function addField() { change(v => { const id = crypto.randomUUID(); v.fields.push({ id, label: l('newField'), type: 'text', owner: defaultFieldOwner, pmKey: null, required: false, sensitive: false, options: [], section: 'main', width: 'full', columns: [], when: null }); v.blocks.push({ id: crypto.randomUUID(), type: 'field', fieldId: id, text: '', section: 'main' }); }); }
  const preview: Document = { id: 'preview', templateId: 'preview', version: version.version, name, status: 'draft', mergeValues: effectivePreviewValues??{ 'company.name': '[Employee’s company]' }, blocks: version.blocks, fields: version.fields, values: Object.fromEntries(version.fields.filter(field => field.pmKey).map(field => [field.id, personnelFieldSourceValue(field, effectivePreviewValues ?? {})])), edits: {}, hrSignature: null, employeeSignature: null, createdAt: '', sentAt: null };
  const missing = personnelPicker && effectivePreviewValues ? Array.from(new Set([
    ...version.blocks.flatMap(block => merge(block.text, effectivePreviewValues).missing),
    ...version.fields.flatMap(field => field.owner === 'pmLocked' && field.pmKey && !effectivePreviewValues[field.pmKey] ? [field.pmKey] : []),
  ])) : [];
  return <div className="v9-stack"><div role="tablist" aria-label={l('version')} className="v9-tabs">{(['content', 'fields', 'preview'] as const).map(t => <button type="button" role="tab" aria-selected={tab === t} key={t} onClick={() => setTab(t)}>{l(t)}</button>)}</div>
    {personnelPicker && previewCases.length > 0 && (tab === 'content' || tab === 'preview') &&
      <Input label="Preview values for"><select value={previewCase} onChange={event => void choosePreview(event.target.value)}>
        <option value="">Choose a case</option>
        {previewCases.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}
      </select></Input>}
    {previewError && <p className="v9-notice v9-error" role="alert">{previewError}</p>}
    {tab === 'preview' ? <>{missing.length > 0 && <aside className="v9-panel" role="status"><strong>Missing Personnel values</strong><ul>{missing.map(key => <li key={key}>{personnelMergeLabels.get(key) ?? key}</li>)}</ul></aside>}<DocumentBody document={preview}/></> : tab === 'content' ? <div className={personnelPicker ? 'grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]' : ''}><div><ol className="v9-list">{version.blocks.map((block, index) => <li className="v9-stack" key={block.id}><h3>{index + 1}. {blockNames[block.type]}</h3>{['heading', 'subheading', 'text'].includes(block.type) && <Input label={`${blockNames[block.type]} ${index + 1}`}><textarea rows={block.type === 'text' ? 5 : 2} value={block.text} disabled={disabled} onFocus={event => { selection.current = { blockId: block.id, node: event.currentTarget }; }} onChange={e => updateBlock(index, { text: e.target.value })}/></Input>}
      {block.type === 'field' && <Input label={l('fieldForBlock',index+1)}><select value={block.fieldId ?? ''} disabled={disabled} onChange={e => updateBlock(index, { fieldId: e.target.value })}><option value="">{l('choose')}</option>{version.fields.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</select></Input>}
      {block.type === 'fields' && <Input label={l('sectionForBlock',index+1)}><input className="v9-input" disabled={disabled} value={block.section} onChange={e => updateBlock(index, { section: e.target.value })}/></Input>}
      {block.type === 'table' && <><Input label={l('columnsForBlock',index+1)}><input className="v9-input" value={block.columns ?? ''} disabled={disabled} placeholder={l('columnPlaceholder')} onChange={e => updateBlock(index, { columns: e.target.value })}/></Input><Input label={l('rowsForBlock',index+1)}><textarea rows={4} value={block.rows ?? ''} disabled={disabled} placeholder={l('rowsPlaceholder')} onChange={e => updateBlock(index, { rows: e.target.value })}/></Input></>}
      {block.type === 'signature' && <><Input label={l('signatureLabel',index+1)}><input className="v9-input" value={block.label ?? ''} disabled={disabled} onChange={e => updateBlock(index, { label: e.target.value })}/></Input><Input label={l('signer',index+1)}><select value={block.role ?? 'employee'} disabled={disabled} onChange={e => updateBlock(index, { role: e.target.value })}><option value="employee">{l('employee')}</option><option value="hr">{l('hr')}</option></select></Input></>}
      <div className="v9-actions"><Button disabled={disabled || !index} click={() => change(v => { [v.blocks[index - 1], v.blocks[index]] = [v.blocks[index], v.blocks[index - 1]]; })}>{l('up',index+1)}</Button><Button disabled={disabled || index === version.blocks.length - 1} click={() => change(v => { [v.blocks[index + 1], v.blocks[index]] = [v.blocks[index], v.blocks[index + 1]]; })}>{l('down',index+1)}</Button><Button disabled={disabled} click={() => change(v => { v.blocks.splice(index, 1); })}>{l('removeBlock',index+1)}</Button></div></li>)}</ol><Input label={l('addBlock')}><select disabled={disabled} value="" onChange={e => { const type = e.target.value as Block['type']; if (type === 'field') { addField(); return; } change(v => v.blocks.push({ id: crypto.randomUUID(), type, text: '', section: 'main', ...(type === 'signature' ? { role: 'employee', label: l('employeeSignature') } : {}) })); }}><option value="">{l('chooseBlock')}</option>{Object.entries(blockNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Input></div>
      {personnelPicker && <aside className="v9-panel v9-stack self-start lg:sticky lg:top-4">
        <h3>Merge fields</h3>
        <Input label="Search merge fields"><input type="search" value={search} onChange={event => setSearch(event.target.value)} /></Input>
        {personnelMergeGroups.map(group => {
          const fields = group.fields.filter(field => field.label.toLowerCase().includes(search.trim().toLowerCase()));
          return fields.length > 0 && <details key={group.label} open={search.trim() !== '' ? true : undefined}>
            <summary>{group.label}</summary>
            {fields.map(field => <div className="v9-actions" key={field.key}>
              <Button disabled={disabled} click={() => insertMergeField(field.key, field.label)}>{field.label}</Button>
              <button type="button" className="v9-button" disabled={disabled} aria-label={'Add ' + field.label + ' as a pre-filled field'} onClick={() => addMergeField(field)}>+</button>
            </div>)}
          </details>;
        })}
        <p className="v9-muted" role="status">{message || 'Click into a text block to insert a merge field.'}</p>
      </aside>}
    </div> : <><p className="v9-muted">{l('ownershipHelp')}</p>{version.fields.map((field, index) => <section className="v9-panel v9-stack" key={field.id}><div className="v9-fields"><Input label={l('fieldLabel',index+1)}><input className="v9-input" value={field.label} disabled={disabled} onChange={e => updateField(index, { label: e.target.value })}/></Input><Input label={l('fieldType',index+1)}><select value={field.type} disabled={disabled} onChange={e => updateField(index, { type: e.target.value as Field['type'] })}>{['text', 'textarea', 'select', 'date', 'checkbox', 'phone', 'email', 'number', 'table'].map(type => <option key={type} value={type}>{l(('type'+type[0].toUpperCase()+type.slice(1)) as keyof TemplateEditorLabels)}</option>)}</select></Input><Input label={l('fieldOwner',index+1)}><select value={field.owner} disabled={disabled} onChange={e => updateField(index, { owner: e.target.value as Field['owner'] })}>{fieldOwners.filter(owner => !personnelPicker || owner !== 'pmLocked' || Boolean(field.pmKey) || field.owner === 'pmLocked').map(owner=><option key={owner} value={owner}>{owner==='employee'?l('employee'):owner==='hr'?l('hr'):l('locked')}</option>)}</select></Input><Input label={l('fieldWidth',index+1)}><select value={field.width ?? 'full'} disabled={disabled} onChange={e => updateField(index, { width: e.target.value as Field['width'] })}><option value="full">{l('full')}</option><option value="half">{l('half')}</option></select></Input><Input label={l('fieldSection',index+1)}><input className="v9-input" value={field.section} disabled={disabled} onChange={e => updateField(index, { section: e.target.value })}/></Input><Input label={l('fieldPersonnel',index+1)}>{personnelPicker ? <select value={field.pmKey ?? ''} disabled={disabled} onChange={e => updateField(index, { pmKey: e.target.value || null, ...(!e.target.value && field.owner === 'pmLocked' ? { owner: defaultFieldOwner } : {}) })}>
        <option value="">No PM link</option>
        {field.pmKey && !personnelMergeGroups.some(group => group.fields.some(item => item.key === field.pmKey)) && <option value={field.pmKey}>{field.pmKey}</option>}
        {personnelMergeGroups.map(group => <optgroup key={group.label} label={group.label}>{group.fields.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</optgroup>)}
      </select> : <input className="v9-input" value={field.pmKey ?? ''} disabled={disabled} onChange={e => updateField(index, { pmKey: e.target.value || null })}/>}</Input></div><div className="v9-actions"><label><input type="checkbox" checked={field.required} disabled={disabled} onChange={e => updateField(index, { required: e.target.checked })}/>{l('required')}</label><label><input type="checkbox" checked={field.sensitive} disabled={disabled} onChange={e => updateField(index, { sensitive: e.target.checked })}/>{l('sensitive')}</label></div>
      {field.type === 'select' && <Input label={l('fieldOptions',index+1)}><textarea rows={4} value={field.options.join('\n')} disabled={disabled} onChange={e => updateField(index, { options: e.target.value.split('\n') })}/></Input>}{field.type === 'table' && <Input label={l('fieldColumns',index+1)}><textarea rows={3} value={(field.columns ?? []).join('\n')} disabled={disabled} onChange={e => updateField(index, { columns: e.target.value.split('\n') })}/></Input>}
      <div className="v9-fields"><Input label={l('fieldWhen',index+1)}><select value={field.when?.field ?? ''} disabled={disabled} onChange={e => updateField(index, { when: e.target.value ? { field: e.target.value, value: '' } : null })}><option value="">{l('always')}</option>{version.fields.filter(f => f.id !== field.id).map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</select></Input>{field.when && <Input label={l('fieldEquals',index+1)}><input className="v9-input" value={field.when.value} disabled={disabled} onChange={e => updateField(index, { when: { field: field.when!.field, value: e.target.value } })}/></Input>}</div><Button disabled={disabled} click={() => change(v => { v.fields.splice(index, 1); v.blocks = v.blocks.filter(b => b.fieldId !== field.id); for (const other of v.fields) if (other.when?.field === field.id) other.when = null; })}>{l('removeField',index+1)}</Button></section>)}<Button disabled={disabled} click={addField}>{l('addField')}</Button></>}
  </div>;
}
