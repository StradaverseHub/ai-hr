import type { Actor, EmailTemplate, Template } from './lifecycle-v9-model';
/** Source constructors start in onboarding; the editor can subsequently change the module. */
export function newV9Template(type: Template['type'], actor: Actor, id: string, now: string): Template {
  const letter = type === 'Letter';
  const fields: Template['versions'][number]['fields'] = type === 'Form' ? [{ id: 'field1', label: 'New field', type: 'text', owner: 'employee', pmKey: null, required: false, sensitive: false, options: [], section: 'main', width: 'half', when: null }] : [];
  const blocks: Template['versions'][number]['blocks'] = [{ id: 'b1', type: 'letterhead', text: '', section: '' }, { id: 'b2', type: 'heading', text: `Untitled ${type.toLowerCase()}`, section: '' }, { id: 'b3', type: 'text', text: 'Dear {employee.name},', section: '' }];
  if (type === 'Form') blocks.push({ id: 'b4', type: 'field', text: '', section: 'main', fieldId: 'field1' });
  if (type !== 'Attachment') blocks.push({ id: 'b5', type: 'signature', text: '', section: '', role: letter ? 'hr' : 'employee', label: letter ? 'Yours sincerely,' : 'I confirm the above.' });
  return { id, name: `New ${type.toLowerCase()}`, type, module: 'onb', rules: {}, hrStep: letter ? 'before' : 'none', employeeAck: letter, retired: false, note: '', versions: [{ version: 1, state: 'draft', at: now, by: actor.name, fields, blocks }] };
}
export function newV9Email(id: string): EmailTemplate { return { id, name: 'New email', module: 'onb', active: false, sender: 'onboarding', subject: '', body: 'Dear {employee.name},\n\n', cc: [], links: [], attachments: [], slots: [] }; }
