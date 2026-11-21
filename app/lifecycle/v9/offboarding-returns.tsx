'use client';
/**
 * d1e26f81 — offboarding "Return and revoke", laid out like onboarding "Equipment and access": the same header,
 * "Set for all items" panel and item summary line, with offboarding's tracking columns kept.
 */
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useOnboardingCopy } from '@/lib/onboarding-copy';
import { CaseItemsTable, CaseSection } from '@/components/lifecycle-v9/case-layout';
import { ItemsSectionHeader, ItemSummaryLine, SetForAllPanel, type BulkChange } from '@/components/lifecycle-v9/bulk-assignment';
import * as M from '@/lib/lifecycle-v9-model';
import type { LifecycleV9Workspace as Workspace, LifecycleV9Command as Command } from '@/packs/lifecycle/service';
import { WorkAssignee } from './work-assignee';
import { CaseStatus } from './case-status';
import { PendingReturns } from './pending-returns';

const date = (value: string | null | undefined) => value && M.validDate(value.slice(0, 10)) ? value.slice(0, 10).split('-').reverse().join('/') : '—';
export function OffboardingReturns({ c, config, users, busy, command, note }: { c: M.Case; config: M.Config; users: Workspace['options']['users']; busy: boolean; command: (value: Command) => Promise<{ ok: boolean; error?: string }>; note: (context: string, label: string) => ReactNode }) {
  const copy = useOnboardingCopy();
  const [bulk, setBulk] = useState(false), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const userName = (id: string | null) => users.find(user => user.id === id)?.name ?? copy('Unassigned');
  const groupName = (id: string | null) => config.groups.find(group => group.id === id)?.name ?? copy('Unassigned team');
  const method = (value: M.Item['method']) => copy(value === 'manual' ? 'Manual' : 'Round robin');
  if (c.state === 'pending') return <CaseSection className="space-y-4" aria-label={copy('Return and revoke')}><PendingReturns c={c} config={config} busy={busy} command={command}/></CaseSection>;
  const open = c.items.filter(M.returnOpen), canBulk = c.state === 'submitted' && open.length > 0;
  async function apply(change: BulkChange) {
    setSaving(true); setError('');
    try { const result = await command({ type: 'itemsBulk', ids: open.map(item => item.id), ...change }); if (!result.ok) setError(result.error ?? copy('The change could not be saved. Your choices are still here. Try again.')); else setBulk(false); }
    catch { setError(copy('The change could not be saved. Your choices are still here. Try again.')); }
    finally { setSaving(false); }
  }
  return <CaseSection className="space-y-4" aria-label={copy('Return and revoke')}>
    <ItemsSectionHeader title={copy('Return and revoke')} count={copy('{count} items', { count: c.items.length })} canBulk={canBulk} open={bulk} onToggle={() => setBulk(value => !value)}/>
    <p className="onb-muted">{copy('Return company items and revoke system access.')}</p>
    {error && <p role="alert" className="v9-notice v9-error">{error}</p>}
    {bulk && canBulk && <SetForAllPanel count={open.length} draft={false} groups={config.groups} busy={busy || saving} apply={change => void apply(change)} cancel={() => setBulk(false)}/>}
    <CaseItemsTable label={copy('Return and revoke')} headings={['Item', 'Type', 'Provided by', 'Owner', 'Return or revoke by', 'Status'].map(label => copy(label))}>
      {c.items.map(item => {
        const editable = c.state === 'submitted' && M.returnOpen(item), team = groupName(item.group);
        return <tr key={item.id}><td><strong>{item.name}</strong>
          {item.cardStep && <p className="onb-muted">{copy(item.cardStep === 'collect' ? 'Collect the card' : 'Deactivate the card')}</p>}
          <ItemSummaryLine team={team} method={item.method} dueDay={item.dueDay} fixedDate={date(item.dueOn)}/>
          <p className="onb-muted">{item.nativeSource ? <Link className="v9-link" href={`/lifecycle/requisitions/onboarding/${item.nativeSource.caseId}`}>{item.nativeSource.requestNumber} · {copy('handed onboarding item')}</Link> : item.sourceId ? copy('Issued asset register') : item.sourceCatalogueId ? copy('Added by HR from the catalogue') : copy('Case item')}{item.kind === 'system' && ' · ' + copy('HR records confirmed revocation')}</p>
          {item.returnReported && item.status !== 'done' && <p className="v9-notice">Employee says this item was returned on {date(item.returnReported.at)}{item.returnReported.note ? ' · ' + item.returnReported.note : ''}. Waiting for the providing team to confirm.</p>}{note(item.id, item.name)}</td>
          <td>{item.kind === 'system' ? 'Access' : 'Item'}</td>
          <td>{item.providedBy ? <><span>{groupName(item.providedBy.group)}</span>{(item.providedBy.userId || item.providedBy.at) && <span className="onb-cell-sub">{[item.providedBy.userId ? userName(item.providedBy.userId) : '', item.providedBy.at ? date(item.providedBy.at) : ''].filter(Boolean).join(' · ')}</span>}</> : '—'}</td>
          <td><div className="lifecycle-case-task-assignee">{editable && item.group ? <WorkAssignee name={item.name} group={item.group} assignee={item.assignee} config={config} users={users} busy={busy} editable exclude={c.facts.employeeUserId} change={userId => command({ type: 'assignItem', id: item.id, userId })}/> : <span>{userName(item.assignee)}</span>}
            <span className="onb-muted">{item.group ? team + ' · ' + method(item.method) : copy('Unassigned')}</span>
            {editable && !item.assignee && (item.assignmentFailure || !item.group) && <p className="lifecycle-case-task-warning" role="note">{item.assignmentFailure ?? copy('Choose an assignment group.')}</p>}</div></td>
          <td>{date(item.dueOn)}{typeof item.dueDay === 'number' && <> ({copy('Day {day}', { day: item.dueDay })})</>}</td>
          <td><CaseStatus name={item.name} kind="item" value={item.status} reason={item.reason} busy={busy} editable={c.state === 'submitted'} change={(status, reason) => command({ type: 'item', id: item.id, status, reason })}/></td></tr>;
      })}
      {!c.items.length && <tr><td colSpan={6}>{copy('No return or revoke items recorded.')}</td></tr>}
    </CaseItemsTable>
  </CaseSection>;
}
