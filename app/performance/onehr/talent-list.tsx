'use client';
import { useEffect,useRef,useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { ArrowDown,ArrowUp,ChevronDown,Sparkles } from 'lucide-react';
import { BandHistoryProvider,TalentBandHistory } from './talent-band-history';
import { TalentBoxMove } from './talent-box-move';
import { inputCls } from '@/components/ui';
import { talentListColumns,talentListRows,talentListValue,talentListValues,type TalentListColumn,type TalentListFilters,type TalentListSort } from '@/packs/performance/onehr/talent-list-model';
import type { CalibrationRosterRow } from './calibration-roster';
import type { TalentBoxGrid } from '@/packs/performance/onehr/talent-board-model';
/** The list model keys the improvement box as "PIP" (its filter and sort value); the screen always names it in full. */
const boxLabel=(value:string)=>value==='PIP'?'PIP/Improvement':value;

function ColumnMenu({column,values,selected,sort,open,onOpen,onSelect,onSort}:{column:TalentListColumn;values:string[];selected:string[]|undefined;sort:TalentListSort;open:boolean;onOpen:(open:boolean)=>void;onSelect:(values:string[]|undefined)=>void;onSort:(direction:1|-1)=>void}){
 const t=useTranslations('onehr.talentList'),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null),all=useRef<HTMLInputElement>(null);
 const [search,setSearch]=useState(''),[position,setPosition]=useState({left:8,top:8,maxHeight:380});
 const label=t(`columns.${column}`),text=(value:string)=>value?column==='box'?boxLabel(value):value:t('blank'),shown=values.filter(value=>text(value).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())),checked=(value:string)=>selected===undefined||selected.includes(value);
 const selectedCount=shown.filter(checked).length;
 useEffect(()=>{if(all.current)all.current.indeterminate=selectedCount>0&&selectedCount<shown.length;},[selectedCount,shown.length,open]);
 useEffect(()=>{if(!open)return;const close=(event:Event)=>{const target=event.target;if(target instanceof Node&&panel.current?.contains(target)||target instanceof HTMLElement&&target.closest('[data-talent-list-scroll]'))return;onOpen(false);};window.addEventListener('scroll',close,true);window.addEventListener('resize',close);return()=>{window.removeEventListener('scroll',close,true);window.removeEventListener('resize',close);};},[open,onOpen]);
 function changeOpen(next:boolean){if(next){const rect=trigger.current?.getBoundingClientRect();if(rect){const below=window.innerHeight-rect.bottom-12,above=rect.top-12,useAbove=below<280&&above>below;setPosition({left:Math.max(8,Math.min(rect.left,window.innerWidth-308)),top:useAbove?Math.max(8,rect.top-Math.min(380,above)-4):rect.bottom+4,maxHeight:Math.max(160,Math.min(380,useAbove?above:below))});}setSearch('');}onOpen(next);}
 function apply(next:string[]){onSelect(values.every(v=>next.includes(v))?undefined:next);}
 const directionLabels=column==='grade'?[t('smallest'),t('largest')]:column==='performance'?['UA → OU','OU → UA']:column==='potential'?['Low → High','High → Low']:column==='box'?['PIP/Improvement → Super Star','Super Star → PIP/Improvement']:['A → Z','Z → A'];
 return <Dialog.Root modal={false} open={open} onOpenChange={changeOpen}>
  <Dialog.Trigger asChild><button ref={trigger} type="button" aria-label={t('filterColumn',{column:label})} className={`flex min-h-11 w-full items-center justify-between gap-1 px-2 text-left text-xs ${selected!==undefined?'text-primary':'text-muted-foreground'}`}><span>{label}</span>{sort.column===column?(sort.direction===1?<ArrowUp size={12}/>:<ArrowDown size={12}/>):<ChevronDown size={12}/>}</button></Dialog.Trigger>
  <Dialog.Portal><Dialog.Content ref={panel} aria-describedby={undefined} style={position} className="fixed z-40 flex w-[min(18.75rem,calc(100vw-1rem))] flex-col gap-2 overflow-hidden rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl">
   <Dialog.Title className="sr-only">{t('filterColumn',{column:label})}</Dialog.Title>
   <div className="grid grid-cols-2 gap-1">{([1,-1] as const).map((direction,index)=><button type="button" key={direction} aria-pressed={sort.column===column&&sort.direction===direction} onClick={()=>{onSort(direction);onOpen(false);}} className="min-h-11 rounded px-2 text-left text-xs hover:bg-muted">{t('sort',{direction:directionLabels[index]})}</button>)}</div>
   <input aria-label={t('searchValues',{column:label})} placeholder={t('search')} className={`${inputCls} shrink-0`} value={search} onChange={event=>{const query=event.target.value;setSearch(query);apply(values.filter(value=>text(value).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));}}/>
   <label className="flex min-h-11 shrink-0 items-center gap-2 text-sm"><input ref={all} type="checkbox" checked={shown.length>0&&selectedCount===shown.length} disabled={!shown.length} onChange={event=>{const next=new Set(selected??values);for(const value of shown)if(event.target.checked)next.add(value);else next.delete(value);apply([...next]);}}/>{t('selectAll')}</label>
   <div className="min-h-0 flex-1 overflow-y-auto border-y border-border py-1">{shown.map(value=><label key={value} title={text(value)} className="flex min-h-11 items-center gap-2 px-1 text-sm"><input type="checkbox" checked={checked(value)} onChange={event=>{const next=new Set(selected??values);if(event.target.checked)next.add(value);else next.delete(value);apply([...next]);}}/><span className="min-w-0 break-words">{text(value)}</span></label>)}{!shown.length&&<p className="py-3 text-xs text-muted-foreground">{t('noValues')}</p>}</div>
   <div className="flex shrink-0 justify-between gap-2"><button type="button" className="min-h-11 px-2 text-sm text-primary" onClick={()=>{setSearch('');onSelect(undefined);}}>{t('clearFilter')}</button><Dialog.Close asChild><button type="button" className="min-h-11 px-2 text-sm font-medium">{t('done')}</button></Dialog.Close></div>
  </Dialog.Content></Dialog.Portal>
 </Dialog.Root>;
}

/** The source Talent Box List, with one unit's filters and both rating axes in the same row. */
export function TalentList({rows,filters,sort,onFilters,onSort,onSelect,onRead,category,lastViewed,active,unitId,height,move}:{rows:CalibrationRosterRow[];filters:TalentListFilters;sort:TalentListSort;onFilters:(filters:TalentListFilters)=>void;onSort:(sort:TalentListSort)=>void;onSelect:(id:string)=>void;onRead?:(id:string)=>void;category:string;lastViewed:string|null;active:boolean;unitId:string;height?:number;move?:{sessionId:string;revision:number;grid?:TalentBoxGrid;onMoved?:(id:string)=>void}}){
 const t=useTranslations('onehr.talentList'),tr=useTranslations('onehr'),[openColumn,setOpenColumn]=useState<TalentListColumn|null>(null);
 const [page,setPage]=useState({key:'',limit:100}),key=JSON.stringify([unitId,category,filters,sort]),sorted=talentListRows(rows,filters,category,sort);
 const reached=lastViewed?sorted.findIndex(row=>row.id===lastViewed)+1:0,limit=Math.max(page.key===key?page.limit:100,Math.ceil(reached/100)*100);
 useEffect(()=>{if(!active){setOpenColumn(null);}},[active]);
 const currentFiltered=talentListColumns.some(column=>filters[column]!==undefined);
 function select(column:TalentListColumn,values:string[]|undefined){const next={...filters};if(values===undefined)delete next[column];else next[column]=values;onFilters(next);}
 const origin=(row:CalibrationRosterRow)=>row.fromCategory??'';
 return <BandHistoryProvider><div className="min-w-0 space-y-2">
  <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 px-5 text-xs text-muted-foreground"><p>{t('count',{count:sorted.length,total:rows.length})}</p>{currentFiltered&&<button type="button" onClick={()=>{onFilters({});setOpenColumn(null);}} className="min-h-11 px-2 text-sm text-primary">{t('clearFilters')}</button>}</div>
  <div data-talent-list-scroll role="region" aria-label={t('title')} tabIndex={0} style={height?{maxHeight:height}:undefined} className="max-h-[32rem] overflow-auto border-y border-border">
   <table className="w-full min-w-[48rem] table-fixed border-collapse text-sm"><caption className="sr-only">{t('title')}</caption><colgroup>{['w-44','w-36','w-20','w-24','w-24','w-36','w-16','w-20'].map((width,index)=><col key={index} className={width}/>)}</colgroup>
    <thead className="sticky top-0 z-10 bg-card"><tr>{talentListColumns.map(column=><th key={column} scope="col" aria-sort={sort.column===column?sort.direction===1?'ascending':'descending':'none'}><ColumnMenu column={column} values={talentListValues(rows,column,filters,category)} selected={filters[column]} sort={sort} open={active&&openColumn===column} onOpen={next=>setOpenColumn(next?column:null)} onSelect={values=>select(column,values)} onSort={direction=>onSort({column,direction})}/></th>)}<th scope="col" className="p-2 text-center text-xs font-medium">AI</th><th scope="col" className="p-2"><span className="sr-only">{t('actions')}</span></th></tr></thead>
    <tbody>{sorted.slice(0,limit).map(row=><tr key={row.id} id={`assessment-${row.id}`} aria-current={lastViewed===row.id?'true':undefined} className={`border-t border-border hover:bg-muted/20 ${lastViewed===row.id?'bg-primary/5':''}`}>
     <th scope="row" className="px-2 py-1 text-left font-normal"><button type="button" aria-label={row.name} title={lastViewed===row.id?`${row.name} · ${tr('calibrationRoster.lastViewed')}`:row.name} onClick={()=>onSelect(row.id)} className="min-h-11 w-full truncate text-left font-medium text-primary hover:underline">{row.name}</button></th>
     <td className="px-2 py-1"><span className="block truncate" title={row.department}>{row.department||'—'}</span></td><td className="px-2 py-1 tabular-nums">{row.grade||'—'}</td>
     {(['performance','potential'] as const).map(axis=><td key={axis} translate="no" className="px-2 py-1"><div className="flex items-center gap-1"><span title={row[`${axis}Source`]==='default'?tr('talentTrail.default'):undefined} className={row[`${axis}Source`]==='default'?'text-muted-foreground':''}>{row[axis]??'—'}{row[`${axis}Source`]==='default'&&<span className="sr-only"> · {tr('talentTrail.default')}</span>}</span><TalentBandHistory active={active} name={row.name} axis={axis} current={row[axis]} source={row[`${axis}Source`]} steps={row.bandTrails?.[axis]??[]}/></div></td>)}
     <td className="px-2 py-1"><span className="font-medium">{boxLabel(talentListValue(row,'box'))||'—'}</span>{row.moved&&<span className="mt-0.5 block text-xs text-muted-foreground">{origin(row)?t('movedFrom',{box:origin(row)}):tr('calibrationRoster.moved')}</span>}</td>
     <td className="px-2 py-1 text-center"><button type="button" aria-label={t('readFor',{name:row.name})} onClick={()=>(onRead??onSelect)(row.id)} className="inline-flex min-h-11 min-w-11 items-center justify-center text-primary"><Sparkles size={16}/></button></td>
     <td className="px-2 py-1">{move?<TalentBoxMove person={row} sessionId={move.sessionId} revision={move.revision} grid={move.grid} disabled={row.locked||row.readOnly||row.canMove===false} onMoved={()=>move.onMoved?.(row.id)}/>:<button type="button" onClick={()=>onSelect(row.id)} className="min-h-11 text-sm text-primary hover:underline">{t('review')}</button>}</td>
    </tr>)}{!sorted.length&&<tr><td colSpan={8} className="px-5 py-8 text-sm text-muted-foreground">{t('empty')}</td></tr>}{sorted.length>limit&&<tr><td colSpan={8} className="px-5 py-2"><button type="button" className="min-h-11 text-sm text-primary" onClick={()=>setPage({key,limit:limit+100})}>{t('showMore',{count:Math.min(100,sorted.length-limit)})}</button></td></tr>}</tbody>
   </table>
  </div>

 </div></BandHistoryProvider>;
}
