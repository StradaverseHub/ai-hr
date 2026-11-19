'use client';
import { useState } from 'react';
import Link from 'next/link';
import type { Case, PMChange } from '@/lib/lifecycle-v9-model';
import type { LifecycleV9Command as Command } from '@/packs/lifecycle/service';
const sensitiveKeys = new Set(['icNo', 'passportNo', 'bankAcc', 'bankAccount', 'taxNo', 'epfNo', 'socsoNo', 'spIc', 'spTax']);
export function PersonnelReview({ c, busy, writableKeys, command }: { c: Case; busy: boolean; writableKeys: string[]; command: (command: Command) => void }) {
  const ids = [...new Set(c.pmChanges.map(change => change.documentId))];
  return <>{ids.map(id => <ReviewGroup key={id} c={c} documentId={id} busy={busy} writableKeys={writableKeys} command={command}/>)}</>;
}
function mask(value: string) { if (!value) return ''; if (value.startsWith('[')) return value; const compact = value.replace(/\s/g, ''); return compact.length <= 4 ? '••••' : `•••• ${compact.slice(-4)}`; }
function ReviewGroup({ c, documentId, busy, writableKeys, command }: { c: Case; documentId: string; busy: boolean; writableKeys: string[]; command: (command: Command) => void }) {
  const document = c.documents.find(document => document.id === documentId), changes = c.pmChanges.filter(change => change.documentId === documentId);
  const [excluded, setExcluded] = useState<string[]>([]), [revealed, setRevealed] = useState<string[]>([]);
  const pending = changes.filter(change => change.status === 'proposed' || change.status === 'conflict'), selected = pending.filter(change => writableKeys.includes(change.field) && !excluded.includes(change.id));
  function field(change: PMChange) { return document?.fields.find(field => field.pmKey === change.field); }
  function sensitive(change: PMChange) { return field(change)?.sensitive || sensitiveKeys.has(change.field); }
  const disabled = busy || c.state !== 'submitted';
  return <section className="v9-panel v9-stack"><h2>Changes for Personnel Management</h2><p className="v9-muted">From {document?.name ?? 'the submitted form'}. Tick the changes to push. Unticked changes stay on the case only.</p><div className="v9-table-scroll"><table className="v9-table"><thead><tr><th>Push</th><th>Field</th><th>Previous value</th><th>Proposed value</th><th>Status</th></tr></thead><tbody>{changes.map(change => {
    const label = field(change)?.label ?? change.field, hidden = sensitive(change) && !revealed.includes(change.id), active = pending.includes(change), supported = writableKeys.includes(change.field);
    return <tr key={change.id}><td><input type="checkbox" aria-label={`Push ${label} to Personnel Management`} checked={active && supported && !excluded.includes(change.id)} disabled={disabled || !active || !supported} onChange={e => setExcluded(ids => e.target.checked ? ids.filter(id => id !== change.id) : [...ids, change.id])}/></td><td>{label}{!supported && <p><Link className="v9-link" href={`/admin/personnel/${c.facts.employmentId}`}>Review field mapping in Personnel</Link></p>}</td><td>{change.before ? hidden ? mask(change.before) : change.before : 'Not in PM'}</td><td>{hidden ? mask(change.after) : change.after || '—'}{sensitive(change) && <button className="v9-link" style={{ marginLeft: 8 }} type="button" aria-label={`${hidden ? 'Show' : 'Hide'} ${label}`} onClick={() => setRevealed(ids => hidden ? [...ids, change.id] : ids.filter(id => id !== change.id))}>{hidden ? 'Show' : 'Hide'}</button>}</td><td>{change.status === 'rejected' ? 'Kept on case only' : change.status === 'conflict' ? 'Personnel source changed; review required' : change.status}</td></tr>;
  })}</tbody></table></div>{pending.length > 0 && <div className="v9-actions"><button type="button" className="v9-button v9-button-primary" disabled={disabled || !selected.length} onClick={() => command({ type: 'pmPushSelected', ids: selected.map(change => change.id) })}>Push {selected.length} {selected.length === 1 ? 'change' : 'changes'} to PM</button><button type="button" className="v9-button" disabled={disabled} onClick={() => command({ type: 'pmKeep', ids: pending.map(change => change.id) })}>Keep on case only</button></div>}</section>;
}
