'use client';
import {useTranslations} from 'next-intl';
export type PriorExtension={id:string;kind:'probation_extension'|'date_shift'|'unclassified'|'current_source';oldEndOn:string|null;newEndOn:string|null;months:3|6|null;recordedAt:string|null};
export function PriorExtensions({events,selected,validated,canValidate,disabled,requiresValidation,onChange}:{events:PriorExtension[];selected:string[];validated:boolean;canValidate:boolean;disabled:boolean;requiresValidation:boolean;onChange:(ids:string[],validated:boolean)=>void}){
 const t=useTranslations('probation');if(!events.length&&!selected.length&&!requiresValidation)return null;
 return <fieldset disabled={disabled||!canValidate} className="v9-stack"><legend>{t('intake.historyTitle')}</legend><p className="v9-muted">{t('intake.historyHelp')}</p>
 {events.map(event=><label key={event.id} className="v9-actions"><input type="checkbox" checked={selected.includes(event.id)} disabled={event.kind==='date_shift'||event.months===null||!event.oldEndOn||!event.newEndOn||!selected.includes(event.id)&&selected.length>=2} onChange={e=>onChange(e.target.checked?events.filter(row=>row.id===event.id||selected.includes(row.id)).map(row=>row.id):selected.filter(id=>id!==event.id),false)}/><span>{event.oldEndOn??'—'} → {event.newEndOn??'—'} · {t('intake.historyKinds.'+event.kind)}{event.months===null?'':' · '+t('planMonths',{months:event.months})}</span></label>)}
 <label className="v9-actions"><input type="checkbox" checked={validated} onChange={e=>onChange(selected,e.target.checked)}/>{t('intake.historyValidated')}</label>{!selected.length&&<p className="v9-muted">{t('intake.historyNoExtension')}</p>}</fieldset>;
}
