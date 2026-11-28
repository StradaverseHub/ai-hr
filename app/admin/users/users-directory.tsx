'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { Avatar, Card, Field, SectionHeader, btnGhost, inputCls, theadCls, thCls } from '@/components/ui';
import { formatDmy, formatDmyTime } from '@/lib/date-display';
import styles from './users-directory.module.css';
import { directoryGrants, directoryType, userType, type DirectoryGroupBy, type UserDirectoryRow } from './directory-model';

/** Board 0735d1b7: one View/Edit link per row. A login opens its account page; a person waiting for a login opens
 * the activation page. Every account action lives on those pages, filtered by the account's status. */
export function directoryHref(u: UserDirectoryRow): string | null {
  if (u.appUserId) return `/admin/users/${u.appUserId}/account`;
  return u.personId ? `/admin/users/activation/${u.personId}` : null;
}

type DirectoryGroup = { key: string; label: string; rows: UserDirectoryRow[] };
type DirectoryEntry = { group: DirectoryGroup; row: UserDirectoryRow | null };
type Props = {
  rows: UserDirectoryRow[];
  groupAdmin: boolean;
  includeArchived: boolean;
  companies: { id: string; name: string }[];
  accounts?:Record<string,{username:string;status:string;activeUntil:string|null;exemptionUntil?:number|null}>;
  /** Latest successful sign-in per app user (ISO instant), from the app-user.logged-in audit events. */
  lastSignIns?:Record<string,string>;
};
type Tier = 'pending' | 'active' | 'inactive';
const statusOrder = ['active', 'pending', 'preparing', 'invited', 'archived'];
const cell = 'min-w-0 px-3 py-3 align-top md:py-1 md:align-middle';
const rowAction = `${styles.rowAction} inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring`;

export function UsersDirectory({ rows, groupAdmin, includeArchived, companies, accounts={}, lastSignIns={} }: Props) {
  const accountT=useTranslations('accountManagement');
  const t = useTranslations('admin.users'), d = useTranslations('admin.users.directory'), locale = useLocale();
  const [search, setSearch] = useState(''), [status, setStatus] = useState(includeArchived ? 'all' : 'current');
  const [role, setRole] = useState('all'), [company, setCompany] = useState('all'), [type, setType] = useState('all');
  const [groupBy, setGroupBy] = useState<DirectoryGroupBy>('none'), [page, setPage] = useState(1);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const pageSize = 20;
  const companyName = (id: string | null) => id ? companies.find(c => c.id === id)?.name ?? d('unknownCompany') : t('groupWide');
  const name = (u: UserDirectoryRow) => u.name ?? (u.appUserId ? t('unlinkedLogin', { id: u.loginSuffix ?? '' }) : u.email ?? d('unnamed'));
  const accountStatus=(u:UserDirectoryRow)=>u.status==='active'&&u.appUserId&&accounts[u.appUserId]?accounts[u.appUserId].status:u.status;
  const statusLabel=(value:string)=>['suspended','expired'].includes(value)?accountT(value):t(`status.${value}`);
  // Account Status (board 07c98c36): three states, with the finer status kept as the detail line and filter.
  const tier=(u:UserDirectoryRow):Tier=>{const value=accountStatus(u);return ['pending','invited','preparing'].includes(value)?'pending':value==='active'?'active':'inactive';};
  const managed=(u:UserDirectoryRow)=>u.appUserId?accounts[u.appUserId]:undefined;
  const availableRoles = [...new Set(rows.flatMap(u => directoryGrants(u).map(g => g.role)))].sort((a,b) => t(`role.${a}`).localeCompare(t(`role.${b}`),locale));
  const filtered = useMemo(() => rows.filter(u => {
    const grants = directoryGrants(u), query = search.trim().toLocaleLowerCase(locale);
    return (!query || `${u.name ?? ''} ${u.email ?? ''} ${u.employeeCode ?? ''} ${u.appUserId?accounts[u.appUserId]?.username??'':''}`.toLocaleLowerCase(locale).includes(query))
      && (status === 'all' || (status === 'current' ? u.status !== 'archived' : accountStatus(u) === status))
      && (type === 'all' || userType(u) === type)
      && (role === 'all' || grants.some(g => g.role === role))
      && (company === 'all' || grants.some(g => (g.companyId ?? 'group') === company && (role === 'all' || g.role === role)));
  }).sort((a,b) => (a.name ?? a.email ?? '').localeCompare(b.name ?? b.email ?? '',locale) || a.key.localeCompare(b.key)), [rows,accounts,search,status,type,role,company,locale]);
  const groups = new Map<string, DirectoryGroup>();
  for (const u of filtered) {
    const grants = directoryGrants(u).filter(g => (role === 'all' || g.role === role) && (company === 'all' || (g.companyId ?? 'group') === company));
    const keys = groupBy === 'none' ? ['all'] : groupBy === 'status' ? [accountStatus(u)] : groupBy === 'type' ? [userType(u)]
      : groupBy === 'role' ? [...new Set(grants.map(g => g.role))] : [...new Set(grants.map(g => g.companyId ?? 'group'))];
    for (const key of keys.length ? keys : ['unassigned']) {
      const label = groupBy === 'status' ? statusLabel(key) : groupBy === 'type' ? d(`userTypeValue.${key}`)
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
  // User Type is a group-administrator column, like its filter (the same people who can invite users).
  const columns:[string,string][]=groupAdmin
    ?[['employeeName','md:w-[13%]'],['employeeId','md:w-[8%]'],['username','md:w-[10%]'],['email','md:w-[14%]'],['userTypeColumn','md:w-[9%]'],['accountStatus','md:w-[12%]'],['role','md:w-[9%]'],['companyScope','md:w-[10%]'],['lastLogin','md:w-[9%]'],['actions','md:w-[6%]']]
    :[['employeeName','md:w-[14%]'],['employeeId','md:w-[9%]'],['username','md:w-[11%]'],['email','md:w-[16%]'],['accountStatus','md:w-[14%]'],['role','md:w-[10%]'],['companyScope','md:w-[11%]'],['lastLogin','md:w-[9%]'],['actions','md:w-[6%]']];
  // Phone: stacked records, every value labelled. Desktop: the label is hidden behind the column header.
  const labelled=(column:string,value:ReactNode,span=false,extra='')=><td className={`${cell} ${span?'col-span-2':''} md:table-cell ${extra}`}><span className="block text-xs text-muted-foreground md:hidden">{d(column)}</span>{value}</td>;
  const unique=(values:string[])=>[...new Set(values)];
  const row=(u:UserDirectoryRow)=>{
    const account=managed(u),state=tier(u),detail=accountStatus(u),grants=directoryGrants(u),signedIn=u.appUserId?lastSignIns[u.appUserId]:undefined;
    const roles=unique(grants.map(g=>t(`role.${g.role}`))),scopes=unique(grants.map(g=>companyName(g.companyId)));
    const paused=account?.exemptionUntil&&account.exemptionUntil>0?account.exemptionUntil:null;
    const href=directoryHref(u),kind=userType(u);
    return <tr data-directory-row className="grid grid-cols-2 border-b border-border hover:bg-muted/20 md:table-row">
        <th scope="row" className={`${cell} col-span-2 font-normal md:table-cell`}><div className="flex min-w-0 items-start gap-3"><Avatar name={name(u)}/><p className="min-w-0 break-words font-medium text-foreground">{name(u)}</p></div></th>
        {labelled('employeeId',<span className="break-all tabular-nums">{u.employeeCode??'—'}</span>)}
        {labelled('username',<span className="break-all font-mono text-xs">{account?.username??'—'}</span>)}
        {labelled('email',<span className="break-all">{u.email??'—'}</span>,true)}
        {groupAdmin&&labelled('userTypeColumn',<div className="space-y-1"><span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${kind==='internal'?'bg-sky-500/10 text-sky-800 dark:text-sky-300':'bg-violet-500/10 text-violet-800 dark:text-violet-300'}`}>{d(`userTypeValue.${kind}`)}</span>
          {directoryType(u)==='unlinked'&&<p className="text-xs text-muted-foreground">{d('unlinkedDetail')}</p>}</div>)}
        {labelled('accountStatus',<div className="space-y-1">
          <span className={`inline-block max-w-full break-words rounded-full px-2 py-0.5 text-xs font-medium ${state==='active'?'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300':state==='pending'?'bg-amber-500/10 text-amber-800 dark:text-amber-300':'bg-muted text-muted-foreground'}`}>{d(`tier.${state}`)}</span>
          {detail!==state&&!(state==='pending'&&detail==='pending')&&<p className="text-xs text-muted-foreground">{statusLabel(detail)}{u.status==='archived'?` · ${t(u.manuallyArchived?'archivedCauseManual':'archivedCauseLeft')}`:''}</p>}
          {u.status==='invited'&&u.invitationDelivery==='failed'&&<p className="text-xs text-destructive">{d('invitationFailed')}</p>}
          {u.status==='invited'&&u.invitationDelivery!=='failed'&&u.invitationSentAt&&<p className="text-xs text-muted-foreground">{d('invitationSent',{date:formatDmyTime(u.invitationSentAt)})}</p>}
          {account?.activeUntil&&<p className="text-xs text-muted-foreground">{d('activeUntil',{date:formatDmy(account.activeUntil)})}</p>}
          {paused&&<p className="text-xs text-amber-800 dark:text-amber-300">{accountT('pausedUntil',{until:formatDmyTime(new Date(paused))})}</p>}
        </div>,true)}
        {labelled('role',grants.length?<ul className="space-y-0.5">{roles.map(r=><li key={r} className="break-words">{r}</li>)}</ul>:<span className="text-muted-foreground">{u.status==='active'?t('noRoles'):'—'}</span>)}
        {labelled('companyScope',grants.length?<span className="break-words">{scopes.join(', ')}</span>:<span className="text-muted-foreground">—</span>)}
        {labelled('lastLogin',signedIn?<span className="tabular-nums">{formatDmyTime(signedIn)}</span>:<span className="text-muted-foreground">{d('neverLoggedIn')}</span>,true)}
        {labelled('actions',<div className="flex flex-col items-start gap-1 md:items-end">{href&&(u.appUserId||groupAdmin)
          ?<a href={href} className={`${rowAction} whitespace-nowrap`} aria-label={d('viewEditFor',{name:name(u)})}>{d('viewEdit')}</a>
          :<span className="text-muted-foreground">—</span>}</div>,true,'md:text-right')}
      </tr>;
  };
  return <Card data-tour="admin-users"><SectionHeader title={t('sectionUsers')} count={rows.length}/>
    <div className="space-y-3 border-b border-border p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,2fr)_1fr_1fr]">
        <label className="min-w-0 space-y-1 text-xs font-medium"><span>{d('search')}</span><div className="relative"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" aria-hidden="true"/><input type="search" className={`${inputCls} min-h-11 pl-9`} placeholder={d('searchPlaceholder')} value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}/></div></label>
        <Field label={t('statusColumn')}><select className={`${inputCls} min-h-11`} value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="current">{d('current')}</option><option value="all">{d('allStatuses')}</option>{(groupAdmin?[...statusOrder,'suspended','expired']:['active','suspended','expired','archived']).map(s=><option key={s} value={s}>{statusLabel(s)}</option>)}</select></Field>
        <Field label={d('roleFilter')}><select className={`${inputCls} min-h-11`} value={role} onChange={e=>{setRole(e.target.value);setPage(1);}}><option value="all">{d('allRoles')}</option>{availableRoles.map(r=><option key={r} value={r}>{t(`role.${r}`)}</option>)}</select></Field>
        <Field label={t('inviteScope')}><select className={`${inputCls} min-h-11`} value={company} onChange={e=>{setCompany(e.target.value);setPage(1);}}><option value="all">{d('allCompanies')}</option><option value="group">{t('groupWide')}</option>{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        {groupAdmin&&<Field label={d('userType')}><select className={`${inputCls} min-h-11`} value={type} onChange={e=>{setType(e.target.value);setPage(1);}}><option value="all">{d('allTypes')}</option>{['internal','external'].map(k=><option key={k} value={k}>{d(`userTypeValue.${k}`)}</option>)}</select></Field>}
        <Field label={d('groupBy')}><select className={`${inputCls} min-h-11`} value={groupBy} onChange={e=>{setGroupBy(e.target.value as DirectoryGroupBy);setPage(1);setCollapsed([]);}}>{(groupAdmin?['none','status','role','company','type']:['none','status','role','company']).map(k=><option key={k} value={k}>{d(`group.${k}`)}</option>)}</select></Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><p role="status">{d('matched',{count:filtered.length,total:rows.length})}</p><button type="button" className="min-h-11 rounded-md px-2 text-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onClick={reset}>{d('clearFilters')}</button></div>
      {(groupBy==='role'||groupBy==='company')&&<p className="text-xs text-muted-foreground">{d('multipleGroups')}</p>}
    </div>
    {filtered.length===0?<div className="space-y-2 px-4 py-10 text-center"><p className="text-sm font-medium">{rows.length?d('noMatches'):t('empty')}</p><p className="text-sm text-muted-foreground">{rows.length?d('noMatchesHelp'):d('emptyHelp')}</p></div>:<>
      <table className={`${styles.directoryTable} block w-full text-left text-sm md:table md:table-fixed`}><thead className={`${theadCls} sr-only md:not-sr-only md:table-header-group`}><tr>{columns.map(([key,width])=><th key={key} scope="col" className={`${thCls} ${width} break-words ${key==='actions'?'text-right':''}`}>{d(key)}</th>)}</tr></thead>
        <tbody className="block md:table-row-group">{visible.map(({group,row:u},index)=>{
          const showGroup=groupBy!=='none'&&(index===0||visible[index-1].group.key!==group.key);
          const key=u?`${group.key}:${u.key}`:`group:${group.key}`;
          return <Fragment key={showGroup?`group-header:${group.key}`:key}>
            {showGroup&&<tr className="block bg-muted/50 md:table-row"><th colSpan={columns.length} scope="rowgroup" className="block px-3 py-1 md:table-cell"><button type="button" className="flex min-h-11 w-full items-center gap-2 text-left text-sm font-medium md:min-h-7 focus-visible:outline-2 focus-visible:outline-ring" aria-expanded={!collapsed.includes(group.key)} onClick={()=>{setCollapsed(prev=>prev.includes(group.key)?prev.filter(k=>k!==group.key):[...prev,group.key]);setPage(1);}}>{collapsed.includes(group.key)?<ChevronRight aria-hidden="true" className="size-4"/>:<ChevronDown aria-hidden="true" className="size-4"/>}{group.label}<span className="font-normal tabular-nums text-muted-foreground">{group.rows.length}</span></button></th></tr>}
            {u&&row(u)}
          </Fragment>;
        })}</tbody>
      </table>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><p className="text-xs tabular-nums text-muted-foreground">{d('range',{from:(currentPage-1)*pageSize+1,to:Math.min(currentPage*pageSize,entries.length),count:entries.length})}</p><div className="flex items-center gap-2"><button type="button" className={`${btnGhost} min-h-11`} disabled={currentPage===1} onClick={()=>setPage(currentPage-1)}>{d('previous')}</button><span className="text-xs tabular-nums">{d('page',{page:currentPage,pages})}</span><button type="button" className={`${btnGhost} min-h-11`} disabled={currentPage===pages} onClick={()=>setPage(currentPage+1)}>{d('next')}</button></div></div>
    </>}
  </Card>;
}
