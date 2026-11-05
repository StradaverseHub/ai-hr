'use client';
import {useEffect,useState} from 'react';
import {useTranslations} from 'next-intl';
import {readApprovedPositionArchitecture} from '@/app/admin/personnel/approved-position-architecture-action';
import type {approvedPositionArchitecture} from '@/packs/job-architecture/service';
import {Button} from '@/components/ui';
type Projection=Awaited<ReturnType<typeof approvedPositionArchitecture>>;
/** A selection preview only. Applying the grade changes the containing form, never an employment. */
export function ApprovedPositionArchitecture({companyId,positionId,gradeIds,onUseGrade,movement=false}:{companyId:string;positionId:string|null|undefined;gradeIds:readonly string[];onUseGrade?:((gradeId:string)=>void);movement?:boolean}){
 const t=useTranslations('jobArchitecture'),key=companyId+':'+(positionId??''),[result,setResult]=useState<{key:string;value?:Projection;error?:string}>();
 useEffect(()=>{let current=true;if(companyId&&positionId){readApprovedPositionArchitecture({companyId,positionId}).then(value=>{if(current)setResult({key,...value});}).catch(()=>{if(current)setResult({key,error:'missing'});});}return()=>{current=false;};},[companyId,positionId,key]);
 if(!companyId||!positionId)return null;
 if(result?.key!==key)return <p role="status" className="text-xs text-muted-foreground">{t('positionPreviewLoading')}</p>;
 if(result.error)return <p role="status" className="text-xs text-muted-foreground">{t('positionPreviewUnavailable')}</p>;
 const value=result.value;if(!value)return <p className="text-xs text-muted-foreground">{t('positionPreviewUnmapped')}</p>;
 return <section aria-label={t('approvedPositionScope')} className="space-y-2 rounded-md border border-border p-3 text-sm"><p className="font-medium">{t('approvedPositionScope')} · JG {value.gradeCode}</p><p className="text-muted-foreground">{value.classification.map(n=>n.title).join(' / ')}</p><p className="text-xs text-muted-foreground">{t('baseRevision',{revision:value.mappingRevision})}</p>{onUseGrade&&gradeIds.includes(value.gradeId)?<Button type="button" size="sm" variant="outline" onClick={()=>onUseGrade(value.gradeId)}>{t('usePositionGrade')}</Button>:null}<p className="text-xs text-muted-foreground">{t(movement?(onUseGrade?'positionMovementHint':'positionReadonlyHint'):'positionDraftHint')}</p></section>;
}
