'use client';

import { Fragment, useId, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import { Avatar, Card, Field, RoleTag, SectionHeader, btnGhost, inputCls, theadCls, thCls } from '@/components/ui';
import { archiveUserAction, assignRoleAction, revokeInvitationAction, revokeRoleAction, setAssistantGrantAction } from '../actions';
import { ManualSubmit } from './manual-submit';
import styles from './users-directory.module.css';
import { directoryGrants, directoryType, type DirectoryGroupBy, type UserDirectoryRow } from './directory-model';

type DirectoryGroup = { key: string; label: string; rows: UserDirectoryRow[] };
type DirectoryEntry = { group: DirectoryGroup; row: UserDirectoryRow | null };
type Props = {
  rows: UserDirectoryRow[];
  groupAdmin: boolean;
  includeArchived: boolean;
  companies: { id: string; name: string }[];
  roleOptions: string[];
  assistantGrantedIds: string[];
};
const statusOrder = ['active', 'pending', 'preparing', 'invited', 'archived'];
const cell = 'min-w-0 px-3 py-3 align-top md:py-1 md:align-middle';
const rowAction = `${styles.rowAction} inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring`;

export function UsersDirectory({ rows, groupAdmin, includeArchived, companies, roleOptions, assistantGrantedIds }: Props) {
  const t = useTranslations('admin.users'), d = useTranslations('admin.users.directory'), locale = useLocale();
  const instance = useId();
  const [search, setSearch] = useState(''), [status, setStatus] = useState(includeArchived ? 'all' : 'current');
  const [role, setRole] = useState('all'), [company, setCompany] = useState('all'), [type, setType] = useState('all');
  const [groupBy, setGroupBy] = useState<DirectoryGroupBy>('none'), [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null), [collapsed, setCollapsed] = useState<string[]>([]);
  const pageSize = 20;
  const companyName = (id: string | null) => id ? companies.find(c => c.id === id)?.name ?? d('unknownCompany') : t('groupWide');
  const name = (u: UserDirectoryRow) => u.name ?? (u.appUserId ? t('unlinkedLogin', { id: u.loginSuffix ?? '' }) : u.email ?? d('unnamed'));
  const availableRoles = [...new Set(rows.flatMap(u => directoryGrants(u).map(g => g.role)))].sort((a,b) => t(`role.${a}`).localeCompare(t(`role.${b}`),locale));
  const filtered = useMemo(() => rows.filter(u => {
    const grants = directoryGrants(u), query = search.trim().toLocaleLowerCase(locale);
    return (!query || `${u.name ?? ''} ${u.email ?? ''}`.toLocaleLowerCase(locale).includes(query))
      && (status === 'all' || (status === 'current' ? u.status !== 'archived' : u.status === status))
      && (type === 'all' || directoryType(u) === type)
      && (role === 'all' || grants.some(g => g.role === role))
      && (company === 'all' || grants.some(g => (g.companyId ?? 'group') === company && (role === 'all' || g.role === role)));
  }).sort((a,b) => (a.name ?? a.email ?? '').localeCompare(b.name ?? b.email ?? '',locale) || a.key.localeCompare(b.key)), [rows,search,status,type,role,company,locale]);
  const groups = new Map<string, DirectoryGroup>();
  for (const u of filtered) {
    const grants = directoryGrants(u).filter(g => (role === 'all' || g.role === role) && (company === 'all' || (g.companyId ?? 'group') === company));
    const keys = groupBy === 'none' ? ['all'] : groupBy === 'status' ? [u.status] : groupBy === 'type' ? [directoryType(u)]
      : groupBy === 'role' ? [...new Set(grants.map(g => g.role))] : [...new Set(grants.map(g => g.companyId ?? 'group'))];
    for (const key of keys.length ? keys : ['unassigned']) {
      const label = groupBy === 'status' ? t(`status.${key}`) : groupBy === 'type' ? d(`type.${key}`)
        : groupBy === 'role' ? key === 'unassigned' ? t('noRoles') : t(`role.${key}`)
        : groupBy === 'company' ? key === 'unassigned' ? d('noScope') : companyName(key === 'group' ? null : key) : '';
      if (!groups.has(key)) groups.set(key, { key, label, rows: [] });
      groups.get(key)!.rows.push(u);
    }
  }
  const orderedGroups = [...groups.values()].sort((a,b) => groupBy === 'status' ? statusOrder.indexOf(a.key)-statusOrder.indexOf(b.key) : a.label.localeCompare(b.label,locale));
  const entries = orderedGroups.flatMap<DirectoryEntry>(g => collapsed.includes(g.key) ? [{ group: g, row: null }] : g.rows.map(row => ({ group: g, row })));
  const pages = Math.max(1,Math.ceil(entries.length/pageSize)), currentPage = Math.min(page,pages);
  const visible = entries.slice((currentPage-1)*pageSize,currentPage*pageSize);
  function reset() { setSearch('');setStatus('current');setRole('all');setCompany('all');setType('all');setPage(1);setCollapsed([]); }
  const panel = (u: UserDirectoryRow) => <div className="space-y-5 bg-muted/30 px-4 py-5 sm:px-6">
    <div><h3 className="text-sm font-semibold">{d('accessFor',{name:name(u)})}</h3><p className="mt-1 text-sm text-muted-foreground">{u.status==='archived' ? t(u.manuallyArchived?'archivedCauseManual':'archivedCauseLeft') : d('accessHelp')}</p>{groupAdmin&&u.hasEmployment===false&&u.personId&&<p className="mt-1 text-xs text-muted-foreground">{t('withoutEmployment')}</p>}</div>
    {u.status==='pending'&&groupAdmin&&u.personId&&<div className="flex flex-wrap gap-2">
      <a href={`/admin/users/create?activate=${u.personId}`} className={btnGhost}>{t('activateManually')}</a>
      <a href={`/admin/users/invite?activate=${u.personId}`} className={btnGhost}>{t('activateByInvitation')}</a>
    </div>}
    {groupAdmin&&u.status==='invited'&&u.invitationId&&<form action={revokeInvitationAction}><input type="hidden" name="invitationId" value={u.invitationId}/><ManualSubmit variant="outline">{t('revokeInvitation')}</ManualSubmit></form>}
    {!!u.roles.length&&<section className="space-y-2"><h4 className="text-xs font-medium text-muted-foreground">{d('assignedRoles')}</h4>
      <ul className="space-y-2">{u.roles.map(g=><li key={g.id} className="flex flex-wrap items-center gap-2 text-sm"><RoleTag role={g.role} label={t(`role.${g.role}`)}/><span>{companyName(g.companyId)}</span>
        {u.status==='active'&&(groupAdmin||(g.role==='hr_admin'&&g.companyId))&&<form action={revokeRoleAction} className="ml-auto"><input type="hidden" name="roleAssignmentId" value={g.id}/><button type="submit" className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm text-destructive hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" aria-label={d('removeRole',{role:t(`role.${g.role}`),scope:companyName(g.companyId)})}><X aria-hidden="true" className="size-4"/>{d('remove')}</button></form>}
      </li>)}</ul>
    </section>}
    {u.status==='active'&&u.appUserId&&<form data-tour="admin-assign" action={assignRoleAction} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
      <input type="hidden" name="appUserId" value={u.appUserId}/>
      <Field label={t('inviteRole')}><select name="role" required defaultValue="" className={inputCls}><option value="" disabled>{d('chooseRole')}</option>{roleOptions.map(r=><option key={r} value={r}>{t(`role.${r}`)}</option>)}</select></Field>
      <Field label={t('inviteScope')}><select name="companyId" required={!groupAdmin} defaultValue="" className={inputCls}>{groupAdmin ? <option value="">{t('groupWide')}</option> : <option value="" disabled>{d('chooseCompany')}</option>}{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <ManualSubmit variant="outline">{t('addRole')}</ManualSubmit>
    </form>}
    {groupAdmin&&u.appUserId&&u.status!=='preparing'&&<div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
      <form action={setAssistantGrantAction}><input type="hidden" name="appUserId" value={u.appUserId}/><input type="hidden" name="granted" value={assistantGrantedIds.includes(u.appUserId)?'false':'true'}/><ManualSubmit variant="outline">{t(assistantGrantedIds.includes(u.appUserId)?'assistantRevoke':'assistantGrant')}</ManualSubmit></form>
      {(u.status==='active'||u.manuallyArchived)&&<form action={archiveUserAction}><input type="hidden" name="appUserId" value={u.appUserId}/><input type="hidden" name="archived" value={u.manuallyArchived?'false':'true'}/><ManualSubmit variant="outline">{t(u.manuallyArchived?'restore':'archive')}</ManualSubmit></form>}
    </div>}
  </div>;
  return <Card data-tour="admin-users"><SectionHeader title={t('sectionUsers')} count={rows.length}/>
    <div className="space-y-3 border-b border-border p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,2fr)_1fr_1fr]">
        <label className="min-w-0 space-y-1 text-xs font-medium"><span>{d('search')}</span><div className="relative"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" aria-hidden="true"/><input type="search" className={`${inputCls} min-h-11 pl-9`} placeholder={d('searchPlaceholder')} value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}/></div></label>
        <Field label={t('statusColumn')}><select className={`${inputCls} min-h-11`} value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="current">{d('current')}</option><option value="all">{d('allStatuses')}</option>{(groupAdmin?statusOrder:['active','archived']).map(s=><option key={s} value={s}>{t(`status.${s}`)}</option>)}</select></Field>
        <Field label={d('roleFilter')}><select className={`${inputCls} min-h-11`} value={role} onChange={e=>{setRole(e.target.value);setPage(1);}}><option value="all">{d('allRoles')}</option>{availableRoles.map(r=><option key={r} value={r}>{t(`role.${r}`)}</option>)}</select></Field>
        <Field label={t('inviteScope')}><select className={`${inputCls} min-h-11`} value={company} onChange={e=>{setCompany(e.target.value);setPage(1);}}><option value="all">{d('allCompanies')}</option><option value="group">{t('groupWide')}</option>{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        {groupAdmin&&<Field label={d('userType')}><select className={`${inputCls} min-h-11`} value={type} onChange={e=>{setType(e.target.value);setPage(1);}}><option value="all">{d('allTypes')}</option>{['employee','standalone','unlinked'].map(k=><option key={k} value={k}>{d(`type.${k}`)}</option>)}</select></Field>}
        <Field label={d('groupBy')}><select className={`${inputCls} min-h-11`} value={groupBy} onChange={e=>{setGroupBy(e.target.value as DirectoryGroupBy);setPage(1);setCollapsed([]);}}>{(groupAdmin?['none','status','role','company','type']:['none','status','role','company']).map(k=><option key={k} value={k}>{d(`group.${k}`)}</option>)}</select></Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><p role="status">{d('matched',{count:filtered.length,total:rows.length})}</p><button type="button" className="min-h-11 rounded-md px-2 text-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onClick={reset}>{d('clearFilters')}</button></div>
      {(groupBy==='role'||groupBy==='company')&&<p className="text-xs text-muted-foreground">{d('multipleGroups')}</p>}
    </div>
    {filtered.length===0?<div className="space-y-2 px-4 py-10 text-center"><p className="text-sm font-medium">{rows.length?d('noMatches'):t('empty')}</p><p className="text-sm text-muted-foreground">{rows.length?d('noMatchesHelp'):d('emptyHelp')}</p></div>:<>
      <table className={`${styles.directoryTable} block w-full text-left text-sm md:table md:table-fixed`}><thead className={`${theadCls} sr-only md:not-sr-only md:table-header-group`}><tr><th scope="col" className={`${thCls} md:w-[32%]`}>{d('user')}</th><th scope="col" className={`${thCls} md:w-[12%]`}>{t('statusColumn')}</th><th scope="col" className={`${thCls} md:w-[30%]`}>{d('access')}</th><th scope="col" className={`${thCls} md:w-[10%]`}>{d('assistant')}</th><th scope="col" className={`${thCls} md:w-[16%]`}><span className="sr-only">{d('actions')}</span></th></tr></thead>
        <tbody className="block md:table-row-group">{visible.map(({group,row:u},index)=>{
          const showGroup=groupBy!=='none'&&(index===0||visible[index-1].group.key!==group.key);
          const key=u?`${group.key}:${u.key}`:`group:${group.key}`,id=`${instance}-access-${currentPage}-${index}`;
          return <Fragment key={showGroup?`group-header:${group.key}`:key}>
            {showGroup&&<tr className="block bg-muted/50 md:table-row"><th colSpan={5} scope="rowgroup" className="block px-3 py-1 md:table-cell"><button type="button" className="flex min-h-11 w-full items-center gap-2 text-left text-sm font-medium md:min-h-7 focus-visible:outline-2 focus-visible:outline-ring" aria-expanded={!collapsed.includes(group.key)} onClick={()=>{setCollapsed(prev=>prev.includes(group.key)?prev.filter(k=>k!==group.key):[...prev,group.key]);setPage(1);}}>{collapsed.includes(group.key)?<ChevronRight aria-hidden="true" className="size-4"/>:<ChevronDown aria-hidden="true" className="size-4"/>}{group.label}<span className="font-normal tabular-nums text-muted-foreground">{group.rows.length}</span></button></th></tr>}
            {u&&<>
              <tr data-directory-row className="grid grid-cols-2 border-b border-border hover:bg-muted/20 md:table-row">
                <th scope="row" className={`${cell} col-span-2 font-normal md:table-cell`}><div className="flex min-w-0 items-start gap-3"><Avatar name={name(u)}/><div className="min-w-0"><p className="break-words font-medium text-foreground">{name(u)}</p><p className="break-all text-xs font-normal text-muted-foreground">{u.email??'—'}</p></div></div></th>
                <td className={`${cell} md:table-cell`}><span className={`inline-block max-w-full break-words rounded-full px-2 py-0.5 text-xs font-medium ${u.status==='active'?'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300':u.status==='invited'?'bg-amber-500/10 text-amber-800 dark:text-amber-300':'bg-muted text-muted-foreground'}`}>{t(`status.${u.status}`)}</span></td>
                <td className={`${cell} col-span-2 md:table-cell`}><span className="mb-1 block text-xs text-muted-foreground md:hidden">{d('access')}</span>{directoryGrants(u).length?<ul className="space-y-1.5 md:space-y-0">{directoryGrants(u).map(g=><li key={g.id} className="break-words"><span className="font-medium">{t(`role.${g.role}`)}</span><span className="ml-1 text-muted-foreground">· {companyName(g.companyId)}</span></li>)}</ul>:<span className="text-muted-foreground">{u.status==='active'?t('noRoles'):d('notGranted')}</span>}</td>
                <td className={`${cell} md:table-cell`}><span className="text-xs text-muted-foreground md:hidden">{d('assistant')}: </span>{groupAdmin&&u.appUserId?<span className="break-words text-xs">{d(assistantGrantedIds.includes(u.appUserId)?'enabled':'off')}</span>:<span className="text-muted-foreground">—</span>}</td>
                <td className={`${cell} text-right md:table-cell`}>{u.status==='preparing'?<a href="/admin/users/create" className={rowAction}>{t('resumeActivation')}</a>:<button type="button" aria-expanded={expanded===key} aria-controls={id} className={`${rowAction} whitespace-nowrap`} title={d('accessFor',{name:name(u)})} onClick={()=>setExpanded(expanded===key?null:key)}>{d(expanded===key?'close':u.status==='pending'?'activate':'manage')}<ChevronDown aria-hidden="true" className={`ml-1 size-4 ${expanded===key?'rotate-180':''}`}/></button>}</td>
              </tr>
              {expanded===key&&<tr className="block md:table-row"><td colSpan={5} className="block md:table-cell"><div id={id} role="region" aria-label={d('accessFor',{name:name(u)})}>{panel(u)}</div></td></tr>}
            </>}
          </Fragment>;
        })}</tbody>
      </table>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><p className="text-xs tabular-nums text-muted-foreground">{d('range',{from:(currentPage-1)*pageSize+1,to:Math.min(currentPage*pageSize,entries.length),count:entries.length})}</p><div className="flex items-center gap-2"><button type="button" className={`${btnGhost} min-h-11`} disabled={currentPage===1} onClick={()=>setPage(currentPage-1)}>{d('previous')}</button><span className="text-xs tabular-nums">{d('page',{page:currentPage,pages})}</span><button type="button" className={`${btnGhost} min-h-11`} disabled={currentPage===pages} onClick={()=>setPage(currentPage+1)}>{d('next')}</button></div></div>
    </>}
  </Card>;
}
