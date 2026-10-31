'use client';
import { useEffect, useState } from 'react';
import type { LifecycleV9CaseDetail, LifecycleV9Command } from '@/packs/lifecycle/service';
import type { Case, Config } from '@/lib/lifecycle-v9-model';
import { readV9Case } from './actions';

type Returns = NonNullable<LifecycleV9CaseDetail['returns']>;
export function PendingReturns({ c, config, busy, command }: { c: Case; config: Config; busy: boolean; command: (value: LifecycleV9Command) => Promise<{ ok: boolean; error?: string }> }) {
  const [detail, setDetail] = useState<Returns | null>(null), [query, setQuery] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true; setDetail(null);
    readV9Case(c.id).then(result => { if (!active) return; if (result.ok && result.detail.case.revision === c.revision && result.detail.returns) { setDetail(result.detail.returns); setError(''); } else setError(result.ok ? 'The case changed. Refresh to review its current items.' : result.error); }).catch(() => { if (active) setError('The return items could not be loaded. Refresh and try again.'); });
    return () => { active = false; };
  }, [c.id, c.revision]);
  const groupName = (id: string | null) => config.groups.find(group => group.id === id)?.name ?? 'Providing team';
  async function save(ids: string[], added = false) {
    setSaving(true); setError('');
    try { const result = await command({ type: 'returnSelections', ids }); if (!result.ok) setError(result.error ?? 'The return selection could not be saved.'); else if (added) setQuery(''); }
    catch { setError('The return selection could not be saved. Your search is still here. Try again.'); }
    finally { setSaving(false); }
  }
  const selected = detail?.selected ?? [], heldIds = new Set(detail?.held.flatMap(item => item.catalogueId ? [item.catalogueId] : []) ?? []), search = query.trim().toLocaleLowerCase();
  const results = detail?.catalogue.filter(item => item.active && !selected.includes(item.id) && !heldIds.has(item.id) && search && (item.name.toLocaleLowerCase().startsWith(search) || item.name.toLocaleLowerCase().includes(' ' + search))) ?? [];
  return <div className="v9-stack">
    {error && <p className="v9-notice v9-error" role="alert">{error}</p>}
    {!detail && !error && <p className="v9-muted" role="status">Loading held items…</p>}
    {detail && <>
      <p className="v9-muted">{detail.held.length + selected.length} items will be revoked or collected. Assigned by round robin when submitted.</p>
      <ul className="v9-list">{detail.held.map(item => <li key={item.id}><div className="v9-heading"><div><strong>{item.name}</strong><div className="v9-muted">{groupName(item.group)} · held by the employee{item.requestNumber ? ' · ' + item.requestNumber : ''}{item.source === 'asset' ? ' · Issued asset register' : ''}</div></div><span className="v9-badge">Preview</span></div></li>)}
      {selected.map(id => { const item = detail.catalogue.find(candidate => candidate.id === id); return <li key={'added:' + id}><div className="v9-heading"><div><strong>{item?.name ?? 'Unavailable catalogue item'}</strong><div className="v9-muted">{groupName(item?.group ?? null)} · added by HR{!item?.active ? ' · retired; remove before submission' : ''}</div></div><div className="v9-actions"><span className="v9-badge">Preview</span><button type="button" className="v9-button" aria-label={'Remove ' + (item?.name ?? 'unavailable item')} disabled={busy || saving} onClick={() => save(selected.filter(candidate => candidate !== id))}>Remove</button></div></div></li>; })}</ul>
      {!detail.held.length && !selected.length && <p className="v9-muted">No return or revoke items recorded.</p>}
      <label className="v9-field"><span>Add an item to return and revoke</span><input className="v9-input" value={query} disabled={busy || saving} placeholder="Search systems, devices or facilities…" onChange={event => setQuery(event.target.value)}/></label>
      {!!results.length && <ul className="v9-list" aria-label="Catalogue search results">{results.map(item => <li key={item.id}><div className="v9-heading"><div><strong>{item.name}</strong><div className="v9-muted">{item.kind === 'system' ? 'System' : 'Device / facility'} · {groupName(item.group)}</div></div><button type="button" className="v9-button" disabled={busy || saving} aria-label={'Add ' + item.name} onClick={() => save([...selected, item.id], true)}>Add</button></div></li>)}</ul>}
      {!!search && !results.length && <p className="v9-muted">No available items match your search.</p>}
    </>}
  </div>;
}
