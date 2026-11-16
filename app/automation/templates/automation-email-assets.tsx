'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {automationEmailBodyText,type AutomationEmailTemplate} from '@/lib/automation/email';
import type {AutomationEmailAsset,AutomationEmailSlot} from '@/lib/automation-email-assets';
import {withoutEmailImage} from '@/lib/email-body/edit';
import {readContractEmailFilePage} from './assets/actions';

const accept='.pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.txt,.csv';
const size=(bytes:number)=>bytes<1048576?`${Math.ceil(bytes/1024)} KB`:`${(bytes/1048576).toFixed(1)} MB`;
async function upload(input:{templateId:string;module:string;revision:number;kind:'image'|'file';file:File;caseId?:string;slotId?:string}):Promise<AutomationEmailAsset>{
 if(!input.file.size||input.file.size>(input.kind==='image'?1048576:10485760))throw new Error(input.kind==='image'?'Use an image of at most 1 MB.':'Use a file of at most 10 MB.');
 const data=new FormData();
 for(const [key,value] of Object.entries(input))if(value!==undefined)data.set(key,value instanceof File?value:String(value));
 const response=await fetch('/automation/templates/assets',{method:'POST',body:data}),result=await response.json() as {asset?:AutomationEmailAsset;error?:string};
 if(!response.ok||!result.asset)throw new Error(result.error??'The file could not be uploaded. Try again.');
 return result.asset;
}
/** Same native email assets as On/Off Boarding, edited here without exposing SMTP settings. */
export function AutomationEmailAssets({template,revision,ready,disabled,onChange,section='both'}:{template:AutomationEmailTemplate;revision:number;ready:boolean;disabled:boolean;onChange:(patch:Partial<AutomationEmailTemplate>)=>void;section?:'images'|'files'|'both'}){
 const t=useTranslations('automation.emailAssets');
 const [busy,start]=useTransition(),[error,setError]=useState('');
 const assets=template.assets??[],blocked=disabled||busy||!ready||revision<1;
 const add=(file:File|undefined,kind:'image'|'file')=>{if(!file||blocked)return;setError('');start(async()=>{try{const asset=await upload({templateId:template.id,module:template.module,revision,kind,file});onChange({assets:[...assets,asset]});}catch(error){setError(error instanceof Error?error.message:'The file could not be uploaded.');}});};
 const remove=(asset:AutomationEmailAsset)=>{const bodyDoc=asset.kind==='image'&&template.bodyDoc?withoutEmailImage(template.bodyDoc,asset.id):null;onChange({assets:assets.filter(item=>item.id!==asset.id),...(bodyDoc?{bodyDoc,body:automationEmailBodyText(bodyDoc)}:{})});};
 return <div className="v9-stack">
  {section!=='files'&&<section className="v9-stack" aria-label={t('imagesTitle')}><h3>{t('imagesTitle')}</h3><p className="v9-muted">{t('imagesHelp')}</p>
   {assets.filter(asset=>asset.kind==='image').map(asset=><div className="automation-row" key={asset.id}><img src={`/automation/templates/assets/${asset.id}`} alt={asset.alt||asset.name} style={{maxWidth:120,maxHeight:80,objectFit:'contain'}}/><label className="v9-field"><span>{t('alt',{name:asset.name})}</span><input maxLength={300} value={asset.alt??''} disabled={disabled||busy} onChange={event=>onChange({assets:assets.map(item=>item.id===asset.id?{...item,alt:event.target.value}:item)})}/></label><button type="button" className="v9-button" disabled={disabled||busy} onClick={()=>remove(asset)}>{t('removeImage')}</button></div>)}
   {assets.filter(asset=>asset.kind==='image').length<3&&<label className="v9-field"><span>{t('addImage')}</span><input type="file" accept=".png,.jpg,.jpeg,.gif,.webp" disabled={blocked} onChange={event=>{const file=event.target.files?.[0];event.target.value='';add(file,'image');}}/></label>}
  </section>}
  {section!=='images'&&<section className="v9-stack" aria-label={t('everyoneTitle')}><h3>{t('everyoneTitle')}</h3><p className="v9-muted">{t('everyoneHelp')}</p>
   <ul className="automation-plain-list">{assets.filter(asset=>asset.kind==='file').map(asset=><li key={asset.id}><a className="v9-link" href={`/automation/templates/assets/${asset.id}`}>{asset.name}</a> <span className="v9-muted">{size(asset.size)}</span> <button type="button" className="v9-button" disabled={disabled||busy} onClick={()=>remove(asset)}>{t('removeFile')}</button></li>)}</ul>
   {assets.length<20&&<label className="v9-field"><span>{t('addFile')}</span><input type="file" accept={accept} disabled={blocked} onChange={event=>{const file=event.target.files?.[0];event.target.value='';add(file,'file');}}/></label>}
  </section>}
  {!ready&&<p className="v9-muted">{t('saveFirst')}</p>}{busy&&<p role="status">{t('uploading')}</p>}{error&&<p className="v9-notice v9-error" role="alert">{error}</p>}
 </div>;
}
export function AutomationEmailFileSlots({slots,disabled,onChange}:{slots:AutomationEmailSlot[];disabled:boolean;onChange:(slots:AutomationEmailSlot[])=>void}){
 const t=useTranslations('automation.emailAssets');
 return <section className="v9-stack" aria-label={t('personTitle')}><h3>{t('personTitle')}</h3><p className="v9-muted">{t('personHelp')}</p>
  {slots.map(slot=><div className="automation-row" key={slot.id}><label className="v9-field"><span>{t('fileLabel')}</span><input value={slot.label} maxLength={500} disabled={disabled} onChange={event=>onChange(slots.map(item=>item.id===slot.id?{...item,label:event.target.value}:item))}/></label><label className="automation-check"><input type="checkbox" checked={slot.required} disabled={disabled} onChange={event=>onChange(slots.map(item=>item.id===slot.id?{...item,required:event.target.checked}:item))}/>{t('requiredBeforeSending')}</label><button type="button" className="v9-button" disabled={disabled} onClick={()=>onChange(slots.filter(item=>item.id!==slot.id))}>{t('removeSlot')}</button></div>)}
  <button type="button" className="v9-button" disabled={disabled||slots.length>=50} onClick={()=>onChange([...slots,{id:crypto.randomUUID(),label:t('defaultSlot'),required:false}])}>{t('addSlot')}</button>
 </section>;
}
export type ContractEmailFileSet={templateId:string;templateName:string;revision:number;slots:(AutomationEmailSlot&{file:AutomationEmailAsset|null})[]};
export function ContractEmailCaseFiles({caseId,items,editable}:{caseId:string;items:ContractEmailFileSet[];editable:boolean}){
 const t=useTranslations('automation.emailAssets'),router=useRouter(),[busy,start]=useTransition(),[error,setError]=useState('');
 const [loaded,setLoaded]=useState<ContractEmailFileSet[]>([]),[hasMore,setHasMore]=useState(items.length===50);
 const shown=[...items,...loaded.filter(item=>!items.some(first=>first.templateId===item.templateId))];
 if(!items.length)return null;
 return <section className="v9-stack" aria-label={t('caseTitle')}><h2>{t('caseTitle')}</h2>{shown.map(template=><div className="v9-stack" key={template.templateId}><h3>{template.templateName}</h3>{template.slots.map(slot=><label className="v9-field" key={slot.id}><span>{slot.label}{slot.required?' · '+t('required'):''}</span>{slot.file?<a className="v9-link" href={`/automation/templates/assets/${slot.file.id}`}>{slot.file.name} ({size(slot.file.size)})</a>:<span className="v9-muted">{slot.required?t('requiredFile'):t('noFile')}</span>}<input type="file" accept={accept} disabled={!editable||busy} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(!file)return;setError('');start(async()=>{try{const asset=await upload({templateId:template.templateId,module:'contract_staff',revision:template.revision,kind:'file',caseId,slotId:slot.id,file});setLoaded(current=>current.map(item=>item.templateId===template.templateId?{...item,slots:item.slots.map(candidate=>candidate.id===slot.id?{...candidate,file:asset}:candidate)}:item));router.refresh();}catch(error){setError(error instanceof Error?error.message:'The file could not be uploaded.');}});}}/></label>)}</div>)}{hasMore&&<button type="button" className="v9-button" disabled={busy} onClick={()=>{setError('');start(async()=>{const result=await readContractEmailFilePage(caseId,shown.length);if(!result.ok){setError(result.error);return;}setLoaded(current=>[...current,...result.page.items.filter(item=>!current.some(existing=>existing.templateId===item.templateId))]);setHasMore(result.page.hasMore);});}}>{t('loadMore')}</button>}{busy&&<p role="status">{t('uploading')}</p>}{error&&<p className="v9-notice v9-error" role="alert">{error}</p>}</section>;
}
