'use client';
import { useState } from 'react';
import type { Config, DefinitionUsage, TemplateUsage } from '@/lib/lifecycle-v9-model';
export function definitionDeleteReason(config: Config, kind: 'document' | 'email', id: string, usage: TemplateUsage[] | undefined, references: DefinitionUsage[] | undefined): string {
  if (!references || kind === 'document' && !usage) return 'Usage must be checked before deleting.';
  const history = references.find(row => row.kind === kind && row.definitionId === id);
  if (kind === 'document' && usage?.some(row => row.templateId === id && row.documents > 0)) return 'Used by documents, so it cannot be deleted. Retire it instead.';
  if (history && (history.messages > 0 || history.runs > 0)) return kind === 'email' ? 'Already used in delivery or workflow history, so it cannot be deleted. Turn it off instead.' : 'Used in workflow history, so it cannot be deleted. Retire it instead.';
  const workflows = config.workflows.filter(workflow => workflow.steps.some(step => 'template' in step && (step.type === 'email' ? kind === 'email' : kind === 'document') && step.template === id));
  if (workflows.length) return `Switch these workflows to another ${kind === 'email' ? 'email' : 'template'} first: ${workflows.map(workflow => workflow.name).join(', ')}.`;
  if (kind === 'document' && config.checklists.some(checklist => checklist.tasks.some(task => task.documentTemplate === id))) return 'Switch the linked checklist tasks to another template first.';
  return '';
}
export function DefinitionDelete({ kind, name, reason, saved, editable, remove }: { kind: 'document' | 'email'; name: string; reason: string; saved: boolean; editable: boolean; remove: () => void }) {
  const [asking,setAsking] = useState(false), noun = kind === 'email' ? 'email' : 'template', blocked = !editable || !saved || !!reason;
  return <section className="v9-stack" aria-label={`Delete ${noun}`}>
    {reason && <p className="v9-muted">{reason}</p>}{!saved && <p className="v9-muted">Save current changes before deleting.</p>}
    {asking ? <div className="v9-actions"><span>Delete {name}?</span><button type="button" className="v9-button v9-button-danger" disabled={blocked} onClick={() => { if (!blocked) remove(); }}>Delete {noun}</button><button type="button" className="v9-button" onClick={() => setAsking(false)}>Cancel deletion</button></div> : <button type="button" className="v9-button v9-button-danger" disabled={blocked} onClick={() => setAsking(true)}>Delete {noun}</button>}
  </section>;
}
