'use client';
import {useTranslations} from 'next-intl';
import type {ProbationIntakePart} from '@/lib/probation-intake-model';
type PartDescriptor=Pick<ProbationIntakePart,'type'|'cycle'>&{dueOn?:string;requiresOffline:boolean};
export function PartMapping({required,parts,evidence,onChange}:{required:readonly PartDescriptor[];parts:ProbationIntakePart[];evidence:{id:string;name:string}[];onChange:(part:PartDescriptor,value:Partial<ProbationIntakePart>|null)=>void}){
 const t=useTranslations('probation');
 return <div className="v9-stack"><p className="v9-muted">{t('intake.partHelp')}</p>{required.map(descriptor=>{const part=parts.find(p=>p.type===descriptor.type&&p.cycle===descriptor.cycle),label=t('partTitle',{part:descriptor.type})+(descriptor.cycle>0?' · '+t('cycle',{cycle:descriptor.cycle}):'');return <div className="v9-fields" key={descriptor.cycle+':'+descriptor.type}>
 <label className="v9-field"><span>{label}</span><select value={part?.status??''} onChange={e=>onChange(descriptor,e.target.value?{status:e.target.value as ProbationIntakePart['status'],evidenceId:null}:null)}><option value="">{t('choose')}</option><option value="unfinished" disabled={descriptor.requiresOffline}>{t('intake.unfinished')}</option><option value="completed_offline">{t('intake.completedOffline')}</option></select>{descriptor.dueOn&&<span className="v9-muted">{t('columns.due')}: {descriptor.dueOn}</span>}</label>
 {part?.status==='completed_offline'&&<label className="v9-field"><span>{t('intake.originalPdf')}</span><select value={part.evidenceId??''} onChange={e=>onChange(descriptor,{evidenceId:e.target.value||null})}><option value="">{t('choose')}</option>{evidence.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}</div>;})}</div>;
}
