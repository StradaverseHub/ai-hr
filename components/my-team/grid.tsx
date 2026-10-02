'use client';
import {useId,useState} from 'react';
import {createPortal} from 'react-dom';
import {useAnchoredPanel} from '@/components/ui/anchored-panel';
import {cn} from '@/lib/utils';
import type {MyTeamEmployee,MyTeamSnapshot,MyTeamNormalizedQuery} from '@/lib/my-team-types';
import {shiftChipClass} from '@/lib/shift-visual';
import {formatDays} from '@/lib/day-format';
import {annualText,dateText,formatMyTeamCell,initials,STATUS_CLASSES,weekFor,type MyTeamTranslate} from './presentation';
export function MyTeamGrid({snapshot,query,locale,t,onOpen}:{snapshot:MyTeamSnapshot;query:MyTeamNormalizedQuery;locale:string;t:MyTeamTranslate;onOpen:(employee:MyTeamEmployee,date:string)=>void}){
 const tooltipId=useId();const [tooltip,setTooltip]=useState<string|null>(null);
 const tooltipPosition=useAnchoredPanel({open:tooltip!==null,onClose:()=>setTooltip(null),width:280,flipHeight:70});
 const showTooltip=(element:HTMLElement,label:string)=>{setTooltip(label);tooltipPosition.anchorTo(element);};
 const employeeById=new Map(snapshot.employees.map(employee=>[employee.employmentId,employee]));
 const employees=snapshot.gridEmploymentIds.map(id=>employeeById.get(id)).filter((employee):employee is MyTeamEmployee=>Boolean(employee));
 const month=query.view==='month';
 const selectedDate=(snapshot.period.from<=snapshot.today&&snapshot.period.to>=snapshot.today)?snapshot.today:snapshot.period.from;
 return <><section className="overflow-hidden rounded-xl border border-border bg-card" aria-label={t('title')}>
 <div className="overflow-x-auto"><table className="w-full table-fixed border-separate border-spacing-0 text-xs" style={{minWidth:220+snapshot.period.gridDates.length*(month?30:112)+(month?0:150)}}>
 <colgroup><col style={{width:220}}/>{snapshot.period.gridDates.map(date=><col key={date} style={{width:month?30:112}}/>)}{!month&&<col style={{width:150}}/>}</colgroup>
 <thead><tr><th scope="col" className="sticky left-0 z-20 border-b border-border bg-card px-4 py-3 text-left font-medium">{t('tile_members')}</th>{snapshot.period.gridDates.map(date=>{
 const today=date===snapshot.today,weekend=[0,6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
 return <th key={date} scope="col" className={`border-b border-border p-2 text-center font-medium ${weekend?'bg-muted/60':'bg-muted/30'} ${today?'text-primary':''}`}><span>{dateText(date,locale,{weekday:month?'narrow':'short'})}</span><span className="mt-1 block text-[10px] tabular-nums">{dateText(date,locale,{day:'numeric'})}</span>{today&&<span className="mt-1 block text-[9px] font-semibold">{t('today')}</span>}</th>;
 })}{!month&&<th scope="col" className="border-b border-border bg-muted/30 p-3 text-left font-medium">{t('thisWeek')}</th>}</tr></thead>
 <tbody>{employees.map(employee=>{
 const days=new Map(employee.days.map(day=>[day.date,day]));const week=weekFor(employee,selectedDate);
 return <tr key={employee.employmentId}><th scope="row" className="sticky left-0 z-10 border-b border-r border-border bg-card p-3 text-left align-top font-normal"><button type="button" className="flex w-full items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={()=>onOpen(employee,selectedDate)}><span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary" aria-hidden>{initials(employee.name)}</span><span className="min-w-0"><span className="block truncate font-medium">{employee.name}</span><span className="mt-1 block truncate text-[10px] text-muted-foreground">{[employee.employeeCode,employee.occupation].filter(Boolean).join(' · ')}</span></span></button><p className={`ml-10 mt-2 text-[10px] tabular-nums ${employee.annualAvailable!==null&&employee.annualAvailable<=2?'text-destructive':'text-muted-foreground'}`}>{annualText(employee,t)}</p></th>
 {snapshot.period.gridDates.map(date=>{
 const day=days.get(date);if(!day)return <td key={date} className="border-b border-r border-border/50 p-1"><span className="sr-only">{t('status_unavailable')}</span></td>;
 const cell=formatMyTeamCell(day,query.layers,locale,t,{today:snapshot.today,view:query.view});const label=t('cellLabel',{employee:employee.name,date:dateText(date,locale),details:cell.description});
 return <td key={date} className={`border-b border-r border-border/50 align-top ${month?'p-0':'p-1'} ${[0,6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())?'bg-muted/20':''}`}><button type="button" aria-label={label} aria-describedby={tooltip===label?tooltipId:undefined} onMouseEnter={event=>{if(month)showTooltip(event.currentTarget,label);}} onMouseLeave={event=>{if(document.activeElement!==event.currentTarget)setTooltip(null);}} onFocus={event=>{if(month)showTooltip(event.currentTarget,label);}} onBlur={()=>setTooltip(null)} onClick={()=>{setTooltip(null);onOpen(employee,date);}} className={`relative block w-full rounded-md border p-2 text-left focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${month?'h-[30px] p-0 text-center text-[10px]':'min-h-[84px]'} ${STATUS_CLASSES[cell.status]} ${cell.pending?'border-dashed border-violet-400 dark:border-violet-500':'border-transparent'} ${date===snapshot.today?'ring-2 ring-inset ring-primary':''}`}>
 {month?<span>{cell.compact}</span>:<>{cell.roster&&<span className={`inline-block max-w-full truncate rounded px-1.5 py-0.5 text-[10px] ${cn(shiftChipClass(day.roster?.color),!day.roster?.isOverride&&'text-muted-foreground')}`}>{cell.roster}</span>}{cell.primary&&<span className="mt-2 block break-words text-[10px]">{cell.primary}</span>}{cell.secondary&&<span className="mt-1 block text-[9px]">{cell.secondary}</span>}</>}
 </button></td>;
 })}{!month&&<td className="border-b border-border p-3 align-top text-[10px] leading-5 text-muted-foreground">{week&&snapshot.availability.attendance==='available'?<><p className="font-medium tabular-nums text-foreground">{t('presentRostered',{present:week.checkedInDays,rostered:week.rosteredDays})}</p><p>{week.lateOrMissingDays===0&&week.absentDays===0&&week.approvedLeaveDays===0?t('noIssues'):t('weekIssues',{issues:week.lateOrMissingDays,absent:week.absentDays,leave:formatDays(week.approvedLeaveDays)})}</p></>:t('status_unavailable')}</td>}</tr>;
 })}</tbody></table></div><p className="border-t border-border p-3 text-[10px] leading-5 text-muted-foreground">{t('footer')}</p></section>{tooltip&&tooltipPosition.at&&createPortal(<div id={tooltipId} role="tooltip" className="pointer-events-none fixed z-[60] w-[280px] rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg" style={{top:tooltipPosition.at.top,left:tooltipPosition.at.left,transform:tooltipPosition.at.flip?'translateY(-100%)':undefined}}>{tooltip}</div>,document.body)}</>;
}
