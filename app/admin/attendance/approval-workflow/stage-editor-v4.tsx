'use client';
import {ApproverPicker} from './approver-picker';
import {useEffect,useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import {Button,inputCls} from '@/components/ui';
import {typeHelpCls,typeLabelCls} from '@/components/ui/section-card';
import {attendanceLevelName} from '@/lib/attendance-workflow';
import {attendanceLevelProblemMessageKey,type AttendanceLevelProblem,type AttendanceV3Source} from '@/lib/attendance-workflow-v3';
import {ATTENDANCE_ESCALATION_DAYS,nextAttendanceSuperiorDepth,validAttendanceEscalationDays,type AttendanceCcSource,type AttendanceV4Level} from '@/lib/attendance-workflow-v4';
type Employee={id:string;name:string;employeeCode?:string|null};
export const emptyAttendanceV4Level=(index:number,previous:readonly AttendanceV4Level[]=[]):AttendanceV4Level=>({name:attendanceLevelName(index),mode:'any_one',sources:[{kind:'direct_manager',depth:nextAttendanceSuperiorDepth(previous)}],hrAlternative:false});

/** Small square icon buttons for the level and source order controls; the accessible names are the existing labels. */
const ICONS={up:'M8 13V3m0 0L4 7m4-4 4 4',down:'M8 3v10m0 0 4-4m-4 4-4-4',remove:'M4 4l8 8m0-8-8 8'} as const;
function IconButton({icon,label,disabled,onClick}:{icon:keyof typeof ICONS;label:string;disabled?:boolean;onClick:()=>void}){
 return <Button type="button" variant="outline" size="icon" className="size-11 sm:size-9" aria-label={label} title={label} disabled={disabled} onClick={onClick}><svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 fill-none stroke-current stroke-[1.5]" strokeLinecap="round" strokeLinejoin="round"><path d={ICONS[icon]}/></svg></Button>;
}

/** One approver or CC source: what kind it is, then its depth, people or addresses, side by side from sm. */
function SourceFields({id,source,employees,onChange,allowCustom=false}:{id:string;source:AttendanceCcSource;employees:Employee[];onChange:(source:AttendanceCcSource)=>void;allowCustom?:boolean}) {
 const v3=useTranslations('attendanceWorkflow.v3'),v4=useTranslations('attendanceWorkflow.v4');
 const [addresses,setAddresses]=useState(source.kind==='custom_email'?source.addresses.join('\n'):'');
 const selected=source.kind==='specific_employee'?source.employmentIds:[];
 return <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]"><label className="block"><span className={typeLabelCls}>{v3('source')}</span><select className={inputCls} value={source.kind} onChange={event=>onChange(event.target.value==='direct_manager'?{kind:'direct_manager',depth:1}:event.target.value==='specific_employee'?{kind:'specific_employee',employmentIds:[]}:{kind:'custom_email',addresses:[]})}><option value="direct_manager">{v3('directSuperior')}</option><option value="specific_employee">{v3('selectedEmployees')}</option>{allowCustom&&<option value="custom_email">{v4('customEmail')}</option>}</select></label>
 {source.kind==='direct_manager'?<div><label className="block"><span className={typeLabelCls}>{v3('depth')}</span><select aria-describedby={`${id}-depth-help`} className={inputCls} value={source.depth} onChange={e=>onChange({...source,depth:Number(e.target.value)})}>{[1,2,3,4,5].map(number=><option key={number} value={number}>{v3('depthOption',{number})}</option>)}</select></label><p id={`${id}-depth-help`} className={`mt-1 ${typeHelpCls}`}>{v3('depthHelp')}</p></div>:source.kind==='custom_email'?<label className="block"><span className={typeLabelCls}>{v4('customEmail')}</span><textarea className={`${inputCls} min-h-24`} maxLength={16050} value={addresses} onChange={e=>{setAddresses(e.target.value);onChange({kind:'custom_email',addresses:e.target.value.split(/[,;\n]/).map(s=>s.trim()).filter(Boolean)});}}/><span className={`mt-1 block ${typeHelpCls}`}>{v4('emailHelp')}</span></label>:<div className="min-w-0">
  <ApproverPicker value={selected} employees={employees} onChange={ids=>onChange({kind:'specific_employee',employmentIds:ids})}/>
 </div>}</div>;
}
const withoutEscalation=(level:AttendanceV4Level):AttendanceV4Level=>{const {escalateAfterDays:_days,...rest}=level;return rest;};
/** Escalation Approval for one non-final level, on one row. An invalid days value is kept so the server refuses it
 * with the level. Same state and validation as before board 03cb9b74; only the arrangement changed. */
function EscalationFields({id,level,onChange}:{id:string;level:AttendanceV4Level;onChange:(level:AttendanceV4Level)=>void}) {
 const v4=useTranslations('attendanceWorkflow.v4'),enabled=level.escalateAfterDays!==undefined;
 const [text,setText]=useState(enabled?String(level.escalateAfterDays):'3');
 const invalid=enabled&&!validAttendanceEscalationDays(level.escalateAfterDays);
 return <fieldset className="min-w-0 space-y-1 rounded-md bg-muted/60 p-3"><legend className="sr-only">{v4('escalationLegend')}</legend>
  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
   <label className="flex min-h-11 items-center gap-2 font-medium"><input type="checkbox" className="size-4" checked={enabled} onChange={e=>{if(!e.target.checked){onChange(withoutEscalation(level));return;}const days=/^[0-9]{1,3}$/.test(text)?Number(text):0;onChange({...level,escalateAfterDays:days});}}/><span>{v4('escalationEnable')}</span></label>
   <span className="text-muted-foreground">{v4('escalationAfter')}</span>
   <label className="sr-only" htmlFor={`${id}-days`}>{v4('escalationDays')}</label>
   <input id={`${id}-days`} type="number" inputMode="numeric" min={ATTENDANCE_ESCALATION_DAYS.min} max={ATTENDANCE_ESCALATION_DAYS.max} step={1} disabled={!enabled} aria-invalid={invalid||undefined} aria-describedby={`${id}-days-help`} className={`${inputCls} w-24`} value={text} onChange={e=>{setText(e.target.value);if(enabled)onChange({...level,escalateAfterDays:/^[0-9]{1,3}$/.test(e.target.value)?Number(e.target.value):0});}}/>
   <span className="text-muted-foreground">{v4('escalationDaysUnit')}</span>
  </div>
  <p id={`${id}-days-help`} className={invalid?'text-xs text-destructive':typeHelpCls}>{invalid?v4('escalationInvalid'):v4('escalationHelp')}</p>
 </fieldset>;
}
const MODES=['any_one','all_required','sequential'] as const;
export function AttendanceStageEditorV4({stages,employees,problems,onChange}:{stages:AttendanceV4Level[];employees:Employee[];problems:readonly AttendanceLevelProblem[];onChange:(levels:AttendanceV4Level[])=>void}) {
 const t=useTranslations('attendanceWorkflow'),v3=useTranslations('attendanceWorkflow.v3'),v4=useTranslations('attendanceWorkflow.v4'),summary=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(problems.length)summary.current?.focus();},[problems]);
 // The final level never escalates; moving or removing levels drops a now-final level's setting.
 const update=(levels:AttendanceV4Level[])=>onChange(levels.map((level,index)=>index===levels.length-1?{...withoutEscalation(level),name:attendanceLevelName(index)}:{...level,name:attendanceLevelName(index)}));
 const patch=(index:number,level:AttendanceV4Level)=>update(stages.map((old,i)=>i===index?level:old));
 const move=(from:number,to:number)=>{const levels=[...stages];[levels[from],levels[to]]=[levels[to],levels[from]];update(levels);};
 const modeName=(mode:AttendanceV4Level['mode'])=>mode==='all_required'?v4('allRequired'):v3(mode==='any_one'?'anyOne':'sequential');
 const sourceName=(source:AttendanceV3Source)=>source.kind==='direct_manager'?v3('depthOption',{number:source.depth}):v3('selectedEmployees');
 return <div className="space-y-4"><p className="text-sm text-muted-foreground">{v4('levelHelp')}</p>{problems.length>0&&<div role="alert" tabIndex={-1} ref={summary} className="space-y-2 rounded-md border border-destructive p-3 text-sm text-destructive"><p>{v3('summary')}</p>{problems.map((problem,i)=><p key={i}>{problem.levelIndex==null?'':`${t('stageNumber',{number:problem.levelIndex+1})}: `}{v3(attendanceLevelProblemMessageKey(problem))}</p>)}</div>}
 <ol className="space-y-5">{stages.map((level,index)=><li key={index} className="overflow-hidden rounded-lg border border-border">
 <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/60 px-4 py-3"><div className="flex min-w-0 flex-wrap items-baseline gap-x-3"><h3 className="font-semibold">{t('stageNumber',{number:index+1})}</h3><span className="min-w-0 text-sm text-muted-foreground">{level.sources[0]?v4('levelSummary',{mode:modeName(level.mode),source:sourceName(level.sources[0]),others:level.sources.length-1}):modeName(level.mode)}</span></div><div className="flex gap-2"><IconButton icon="up" label={t('moveUp')} disabled={index===0} onClick={()=>move(index,index-1)}/><IconButton icon="down" label={v3('moveDown')} disabled={index===stages.length-1} onClick={()=>move(index,index+1)}/><IconButton icon="remove" label={`${t('remove')} ${t('stageNumber',{number:index+1})}`} disabled={stages.length===1} onClick={()=>update(stages.filter((_,i)=>i!==index))}/></div></div>
 <div className="space-y-4 p-4">
 <fieldset className="min-w-0"><legend className={`mb-2 ${typeLabelCls}`}>{v3('mode')}</legend><div className="grid gap-3 md:grid-cols-3">{MODES.map(mode=><label key={mode} className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"><input type="radio" className="mt-1" name={`v4-mode-${index}`} checked={level.mode===mode} onChange={()=>patch(index,{...level,mode})}/><span><span className="font-medium">{modeName(mode)}</span><span className="block text-xs text-muted-foreground">{mode==='all_required'?v4('allRequiredHelp'):v3(mode==='any_one'?'anyOneHelp':'sequentialHelp')}</span></span></label>)}</div></fieldset>
 <ol className="divide-y divide-border border-y border-border">{level.sources.map((source,sourceIndex)=><li key={sourceIndex} className="grid gap-3 py-4 sm:grid-cols-[6rem_minmax(0,1fr)_auto] sm:items-start"><span className="text-sm font-medium sm:pt-6">{v4('sourceNumber',{number:sourceIndex+1})}</span><SourceFields key={`${sourceIndex}-${source.kind}`} id={`v4-${index}-${sourceIndex}`} source={source} employees={employees} onChange={next=>patch(index,{...level,sources:level.sources.map((old,i)=>i===sourceIndex?next as AttendanceV3Source:old),hrAlternative:false})}/><div className="flex gap-2 sm:pt-5"><IconButton icon="up" label={t('moveUp')} disabled={sourceIndex===0} onClick={()=>{const sources=[...level.sources];[sources[sourceIndex-1],sources[sourceIndex]]=[sources[sourceIndex],sources[sourceIndex-1]];patch(index,{...level,sources});}}/><IconButton icon="down" label={v3('moveDown')} disabled={sourceIndex===level.sources.length-1} onClick={()=>{const sources=[...level.sources];[sources[sourceIndex+1],sources[sourceIndex]]=[sources[sourceIndex],sources[sourceIndex+1]];patch(index,{...level,sources});}}/><IconButton icon="remove" label={t('remove')} disabled={level.sources.length===1} onClick={()=>patch(index,{...level,sources:level.sources.filter((_,i)=>i!==sourceIndex),hrAlternative:false})}/></div></li>)}</ol>
 <Button type="button" variant="outline" disabled={level.sources.length>=20} onClick={()=>patch(index,{...level,sources:[...level.sources,{kind:'direct_manager',depth:nextAttendanceSuperiorDepth(stages.slice(0,index))}],hrAlternative:false})}>{v4('addSource')}</Button>
 {level.sources.length===1&&level.sources[0].kind==='direct_manager'&&<label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={level.hrAlternative} onChange={e=>patch(index,{...level,hrAlternative:e.target.checked})}/>{v3('hrAlternative')}</label>}
 {index<stages.length-1?<EscalationFields key={`escalation-${index}-${stages.length}`} id={`v4-escalation-${index}`} level={level} onChange={next=>patch(index,next)}/>:<p className="text-sm text-muted-foreground">{v4('escalationFinal')}</p>}
 </div>
 </li>)}</ol><div className="flex flex-wrap items-center gap-3"><Button type="button" variant="outline" disabled={stages.length>=10} onClick={()=>update([...stages,emptyAttendanceV4Level(stages.length,stages)])}>{t('addStage')}</Button><p className="text-xs text-muted-foreground">{v3('limits')}</p></div></div>;
}
/** CC recipients: their own form section (board 03cb9b74); the section supplies the heading and help. */
export function AttendanceCcEditor({sources,employees,onChange}:{sources:AttendanceCcSource[];employees:Employee[];onChange:(sources:AttendanceCcSource[])=>void}) {
 const t=useTranslations('attendanceWorkflow'),v4=useTranslations('attendanceWorkflow.v4');
 return <div className="space-y-4">{sources.length>0&&<ol className="divide-y divide-border border-y border-border">{sources.map((source,index)=><li key={index} className="grid gap-3 py-4 sm:grid-cols-[6rem_minmax(0,1fr)_auto] sm:items-start"><span className="text-sm font-medium sm:pt-6">{v4('ccNumber',{number:index+1})}</span><SourceFields key={`${index}-${source.kind}`} id={`v4-cc-${index}`} source={source} employees={employees} allowCustom onChange={next=>onChange(sources.map((old,i)=>i===index?next:old))}/><div className="sm:pt-5"><Button type="button" variant="ghost" className="text-primary" onClick={()=>onChange(sources.filter((_,i)=>i!==index))}>{t('remove')}</Button></div></li>)}</ol>}<Button type="button" variant="outline" disabled={sources.length>=20} onClick={()=>onChange([...sources,{kind:'specific_employee',employmentIds:[]}])}>{v4('addCc')}</Button></div>;
}
