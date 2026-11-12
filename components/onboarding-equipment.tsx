'use client';
import { ActionButton } from '@/components/ui/action-button';
import {useOnboardingCopy} from '@/lib/onboarding-copy';
import {CaseItemsTable,CaseSection} from '@/components/lifecycle-v9/case-layout';
import {ItemsSectionHeader,ItemSummaryLine,SetForAllPanel} from '@/components/lifecycle-v9/bulk-assignment';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { currentReq, activeItem, equipmentDate, inGroup, type Actor, type Case, type Config, type EquipmentBulk } from '@/lib/onboarding-model';
import { changeOnboarding } from '@/app/lifecycle/onboarding/v31-actions';
type Preferences = NonNullable<Case['equipmentOverrides']>;
const date = (value: string) => value.split('-').reverse().join('/');
export function OnboardingEquipment({ c, config, actor, directory, revision, draft }: { c: Case; config: Config; actor: Actor; directory: { id: string; name: string }[]; revision: number; draft?: { ids: string[]; values: Preferences; change: (values: Preferences) => void } }) {
  const copy=useOnboardingCopy();
  const [bulk, setBulk] = useState(false), [error, setError] = useState(''), [busy, start] = useTransition(), router = useRouter(), request = currentReq(c);
  const rows = request?.items ?? [], open = rows.filter(item => !item.removed && !['rejected','withdrawn'].includes(item.approval) && !['ready','handed'].includes(item.state));
  const ids = draft?.ids ?? open.map(item => item.id), closed = c.state === 'cancelled' || !!request?.cancelledAt || !!request?.handedAt;
  const canBulk = !!(actor.module||actor.caseActions&&actor.sections?.equip==='act') && !closed && ids.length > 0;
  const groupName = (id: string) => config.groups.find(group => group.id === id)?.name ?? copy('Unassigned team');
  function command(value: Parameters<typeof changeOnboarding>[2], close = false) {
    start(async () => {
      setError('');
      try { const result = await changeOnboarding(c.id, revision, value); if (result.error) setError(result.error); else { if (close) setBulk(false); router.refresh(); } }
      catch { setError('The equipment change could not be saved. Your choices are still here. Try again.'); }
    });
  }
  function update(change: EquipmentBulk) {
    if (draft) {
      const values = structuredClone(draft.values);
      for (const id of change.ids) values[id] = { ...values[id], ...(change.group !== undefined ? { group: change.group } : {}), ...(change.method !== undefined ? { method: change.method } : {}), ...(change.due !== undefined ? { due: change.due } : {}) };
      draft.change(values); setBulk(false);
    } else command({ type: 'equipmentBulk', ...change }, true);
  }
  return <CaseSection className="space-y-4" aria-label={copy("Equipment and access")}><ItemsSectionHeader title={copy("Equipment and access")} count={draft ? copy('{count} selected items',{count:ids.length}) : copy('{count} requested items',{count:rows.filter(item=>!item.removed).length})} canBulk={canBulk} open={bulk} onToggle={() => setBulk(value => !value)}/>
    {error && <p role="alert" className="v9-notice v9-error">{error}</p>}
    {bulk && <SetForAllPanel count={ids.length} draft={!!draft} groups={config.groups} busy={busy} apply={change => update({ ids, ...change })} cancel={() => setBulk(false)}/>}
    {draft ? <ul className="v9-list">{draft.ids.map(id => { const catalogue = config.catalogue.find(item => item.id === id), value = draft.values[id]; return <li key={id}><strong>{catalogue?.name ?? 'Unavailable catalogue item'}</strong><ItemSummaryLine team={groupName(value?.group ?? catalogue?.team ?? '')} method={value?.method} dueDay={value?.due ?? -1}/></li>; })}</ul> : <CaseItemsTable label={copy("Equipment and access")} headings={['Item', 'Provided by', 'Owner', 'Due by', 'Status'].map(label=>copy(label))}>{rows.map(item => {
      const complete = ['ready','handed'].includes(item.state), available = !closed && activeItem(item) && !complete, manage = available && (actor.module || actor.caseActions&&actor.sections?.equip==='act' || inGroup(config, item.team, actor.id)), currentOwner = directory.find(user => user.id === item.claim)?.name ?? (item.claim ? 'Unavailable person' : 'Unassigned');
      return <tr key={item.id}><td><strong>{item.name}</strong><div className="onb-muted">{(item.fulfilmentMethod ?? 'manual') === 'rr' ? 'Round robin' : 'Manual'}{item.assignmentFailure ? ' · ' + item.assignmentFailure : ''}</div></td><td>{groupName(item.team)}</td><td>{manage ? <div className="v9-stack"><select aria-label={`Owner for ${item.name}`} value={item.claim ?? ''} disabled={busy} onChange={event => command({ type: 'equipmentAssignee', itemId: item.id, user: event.target.value || null, roundRobin: false })}><option value="">Unassigned</option>{item.claim && !directory.some(user => user.id === item.claim && inGroup(config, item.team, user.id)) && <option value={item.claim} disabled>{currentOwner}</option>}{directory.filter(user => inGroup(config, item.team, user.id)).map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select><ActionButton guardNavigation aria-busy={busy} type="button" className="v9-link" disabled={busy} onClick={() => command({ type: 'equipmentAssignee', itemId: item.id, user: null, roundRobin: true })}>Assign by round robin</ActionButton></div> : currentOwner}</td><td>{date(equipmentDate(c, item))}</td><td>{available && inGroup(config, item.team, actor.id) ? <select aria-label={`Status of ${item.name}`} value={item.state === 'progress' ? 'progress' : 'todo'} disabled={busy || !!item.claim && item.claim !== actor.id} onChange={event => command({ type: 'fulfil', itemId: item.id, status: event.target.value as 'todo' | 'progress' | 'done' })}><option value="todo">To do</option><option value="progress">In progress</option><option value="done">{item.card ? item.stage === 'facility' ? 'Print and send card' : 'Activate card' : 'Done'}</option></select> : <span className="v9-badge">{item.removed ? 'Removed' : item.approval === 'pending' ? 'Awaiting approval' : item.approval === 'rejected' ? 'Rejected' : item.state === 'handed' ? 'Handed over' : item.state === 'ready' ? 'Ready' : item.state === 'printed' ? 'Printed' : item.state === 'progress' ? 'In progress' : 'To do'}</span>}</td></tr>;
    })}{!rows.length && <tr><td colSpan={5}>{copy("No equipment or access requested.")}</td></tr>}</CaseItemsTable>}
    {draft && <p className="onb-muted">{copy('These preferences apply to this case when you save and submit it.')}</p>}
  </CaseSection>;
}
