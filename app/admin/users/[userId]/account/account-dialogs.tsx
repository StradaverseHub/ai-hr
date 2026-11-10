'use client';
/** Board 07c98c36: Reset Password and Authenticator Control, opened from an employee's row in the Users list
 * (and from the account page). Each dialog is a thin client over the existing audited owner,
 * core/account-management.ts, through the same server action and scope proof as every account action.
 * The employee's current password is never read or shown; a generated candidate comes from the saved
 * Password Policy and is held only in this dialog's state. */
import * as Dialog from '@radix-ui/react-dialog';
import {X} from 'lucide-react';
import {startTransition,useActionState,useEffect,useId,useState,type ReactNode} from 'react';
import {useTranslations} from 'next-intl';
import {ActionButton} from '@/components/ui/action-button';
import {btnGhost,btnPrimary,inputCls} from '@/components/ui';
import {formatDmyTime} from '@/lib/date-display';
import {kualaLumpurLocalInput} from '@/lib/hr-date';
import {accountAction,accountHistoryAction,generatePasswordAction,type AccountActionState,type AccountHistoryEntry} from './actions';
import {historyLabelKey,historyShowsActor} from './history-model';

const HOURS=[1,2,4,8,12,24] as const;
const DAY=24*3600_000,MAX_PAUSE=7*DAY,MIN_PAUSE=5*60_000;
const panel='fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg sm:p-6';
const label='block space-y-1 text-sm';
const caption='text-xs font-medium uppercase tracking-wide text-muted-foreground';
const readOnlyCls=`${inputCls} min-h-11 border-dashed bg-muted text-muted-foreground`;
const button=(cls:string)=>`${cls.replace('h-9','min-h-11')} whitespace-normal`;

function Shell({open,onOpenChange,trigger,triggerClassName,title,description,children}:{open:boolean;onOpenChange:(open:boolean)=>void;trigger:string;triggerClassName:string;title:string;description?:string;children:ReactNode}){
 const t=useTranslations('accountManagement');
 return <Dialog.Root open={open} onOpenChange={onOpenChange}>
  <Dialog.Trigger asChild><button type="button" className={triggerClassName}>{trigger}</button></Dialog.Trigger>
  <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/>
   <Dialog.Content className={panel} {...(description?{}:{'aria-describedby':undefined})}>
    <div className="mb-4 flex items-start justify-between gap-4"><div><Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>{description&&<Dialog.Description className="mt-1 text-sm text-muted-foreground">{description}</Dialog.Description>}</div>
     <Dialog.Close className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" aria-label={t('dialogClose')}><X aria-hidden="true" className="size-4"/></Dialog.Close></div>
    {children}
   </Dialog.Content>
  </Dialog.Portal>
 </Dialog.Root>;
}

export function ResetPasswordDialog({userId,name,username,triggerClassName}:{userId:string;name:string;username:string;triggerClassName:string}){
 const t=useTranslations('accountManagement.resetPassword'),[open,setOpen]=useState(false);
 return <Shell open={open} onOpenChange={setOpen} trigger={t('open')} triggerClassName={triggerClassName} title={t('title')}>
  {/* Mounted only while open: every opening starts empty, and closing discards the typed password. */}
  <ResetPasswordForm userId={userId} name={name} username={username} close={()=>setOpen(false)}/>
 </Shell>;
}
function ResetPasswordForm({userId,name,username,close}:{userId:string;name:string;username:string;close:()=>void}){
 const t=useTranslations('accountManagement.resetPassword'),id=useId();
 const [state,action,pending]=useActionState<AccountActionState,FormData>(accountAction,{status:'idle'});
 const [password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[hours,setHours]=useState('24'),[reason,setReason]=useState('');
 const [note,setNote]=useState<'generated'|'generateFailed'|'copied'|'copyFailed'|'mismatch'|null>(null),[generating,setGenerating]=useState(false);
 async function generate(){
  setGenerating(true);setNote(null);
  try{const result=await generatePasswordAction(userId);if(result.status==='ok'){setPassword(result.password);setConfirm(result.password);setNote('generated');}else setNote('generateFailed');}
  catch{setNote('generateFailed');}finally{setGenerating(false);}
 }
 async function copy(){
  try{if(!password||!navigator.clipboard)throw Error('unavailable');await navigator.clipboard.writeText(password);setNote('copied');}catch{setNote('copyFailed');}
 }
 const saved=state.status==='saved';
 return <form className="space-y-4" onSubmit={event=>{
   event.preventDefault();
   if(password!==confirm){setNote('mismatch');return;}
   const form=new FormData(event.currentTarget);startTransition(()=>action(form));
  }}>
  <input type="hidden" name="type" value="temporary-password"/><input type="hidden" name="userId" value={userId}/><input type="hidden" name="confirmed" value="on"/>
  <div className="grid gap-4 sm:grid-cols-2">
   <label className={label}><span className={caption}>{t('employeeName')}</span><input readOnly value={name} className={readOnlyCls}/></label>
   <label className={label}><span className={caption}>{t('username')}</span><input readOnly value={username} className={readOnlyCls}/></label>
  </div>
  <div className="space-y-2">
   <label htmlFor={`${id}-password`} className={caption}>{t('temporaryPassword')} <span aria-hidden="true" className="text-destructive">*</span></label>
   <div className="flex flex-col gap-2 sm:flex-row">
    <input id={`${id}-password`} name="password" type="text" required maxLength={128} autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" value={password} onChange={event=>{setPassword(event.target.value);setNote(null);}} className={`${inputCls} min-h-11 font-mono`}/>
    <button type="button" className={button(btnGhost)} disabled={generating||saved} aria-busy={generating} onClick={generate}>{generating?t('generating'):t('generate')}</button>
    <button type="button" className={button(btnGhost)} disabled={!password} onClick={copy}>{note==='copied'?t('copied'):t('copy')}</button>
   </div>
   <p className="text-sm text-muted-foreground">{t('generatedHint')}</p>
  </div>
  <label className={label}><span className={caption}>{t('confirmPassword')} <span aria-hidden="true" className="text-destructive">*</span></span>
   <input name="confirmPassword" type="text" required maxLength={128} autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" value={confirm} onChange={event=>{setConfirm(event.target.value);setNote(null);}} aria-invalid={note==='mismatch'} className={`${inputCls} min-h-11 font-mono`}/></label>
  <label className={label}><span className={caption}>{t('expiresAfter')}</span>
   <select name="hours" value={hours} onChange={event=>setHours(event.target.value)} className={`${inputCls} min-h-11 sm:max-w-xs`}>{HOURS.map(value=><option key={value} value={value}>{t('hours',{count:value})}</option>)}</select></label>
  <label className={label}><span className={caption}>{t('reasonOptional')}</span>
   <textarea name="reason" maxLength={500} minLength={reason.trim()?5:undefined} value={reason} onChange={event=>setReason(event.target.value)} className={`${inputCls} min-h-16`}/></label>
  <p className="text-sm text-muted-foreground">{t('help')}</p>
  {note&&note!=='copied'&&note!=='generated'&&<p role="alert" className="text-sm text-destructive">{t(note)}</p>}
  {note==='copied'&&<p role="status" className="text-sm">{t('copiedStatus')}</p>}
  {state.status==='saved'&&<p role="status" className="text-sm font-medium">{t('saved')}</p>}
  {state.status==='failed'&&<p role="alert" className="text-sm text-destructive">{t('failed')}</p>}
  <div className="flex flex-wrap justify-end gap-2">
   <button type="button" className={button(btnGhost)} onClick={close}>{saved?t('done'):t('cancel')}</button>
   {!saved&&<ActionButton type="submit" aria-busy={pending} disabled={pending} className={button(btnPrimary)}>{t('submit')}</ActionButton>}
  </div>
 </form>;
}

export function AuthenticatorControlDialog({userId,name,exemptionUntil,triggerClassName}:{userId:string;name:string;exemptionUntil:number|null;triggerClassName:string}){
 const t=useTranslations('accountManagement.authenticator'),[open,setOpen]=useState(false);
 return <Shell open={open} onOpenChange={setOpen} trigger={t('open')} triggerClassName={triggerClassName} title={t('title',{name})}>
  <AuthenticatorForms userId={userId} name={name} exemptionUntil={exemptionUntil}/>
 </Shell>;
}
function AuthenticatorForms({userId,name,exemptionUntil}:{userId:string;name:string;exemptionUntil:number|null}){
 const t=useTranslations('accountManagement.authenticator'),h=useTranslations('accountManagement.historyEvent'),id=useId();
 const [pause,pauseAction,pausing]=useActionState<AccountActionState,FormData>(accountAction,{status:'idle'});
 const [resume,resumeAction,resuming]=useActionState<AccountActionState,FormData>(accountAction,{status:'idle'});
 // Opening time anchors the allowed window; the server re-checks it against its own clock.
 const [opened]=useState(()=>Date.now());
 const paused=exemptionUntil!==null&&exemptionUntil>opened&&resume.status!=='saved';
 const [mode,setMode]=useState<'required'|'paused'>(paused?'paused':'required');
 const [until,setUntil]=useState(()=>kualaLumpurLocalInput(paused?exemptionUntil!:opened+DAY));
 const [history,setHistory]=useState<{status:'loading'|'failed'}|{status:'ok';entries:AccountHistoryEntry[]}>({status:'loading'});
 const historyKey=`${pause.status}:${resume.status}`;
 useEffect(()=>{let live=true;accountHistoryAction(userId).then(result=>{if(live)setHistory(result);},()=>{if(live)setHistory({status:'failed'});});return()=>{live=false;};},[userId,historyKey]);
 const savedUntil=pause.status==='saved'?until:null;
 const statusText=resume.status==='saved'?t('statusRequired'):savedUntil?t('statusPaused',{until:formatDmyTime(new Date(`${savedUntil}:00+08:00`))}):paused?t('statusPaused',{until:formatDmyTime(new Date(exemptionUntil!))}):t('statusRequired');
 return <div className="space-y-5">
  <div className="space-y-2"><p className={caption} id={`${id}-requirement`}>{t('requirement')}</p>
   <div role="group" aria-labelledby={`${id}-requirement`} className="inline-flex rounded-md border border-border p-1">
    {(['required','paused'] as const).map(value=><button key={value} type="button" aria-pressed={mode===value} onClick={()=>setMode(value)} className={`min-h-11 rounded px-4 text-sm ${mode===value?'bg-primary text-primary-foreground':'hover:bg-muted'}`}>{t(value)}</button>)}
   </div>
   <p className="text-sm"><span className="text-muted-foreground">{t('status')}: </span><span role="status">{statusText}</span></p>
  </div>
  {mode==='paused'&&<form className="space-y-4" onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);startTransition(()=>pauseAction(form));}}>
   <input type="hidden" name="type" value="recovery-exemption"/><input type="hidden" name="userId" value={userId}/><input type="hidden" name="confirmed" value="on"/>
   <label className={label}><span className={caption}>{t('expiry')} <span aria-hidden="true" className="text-destructive">*</span></span>
    <input name="until" type="datetime-local" required min={kualaLumpurLocalInput(opened+MIN_PAUSE)} max={kualaLumpurLocalInput(opened+MAX_PAUSE)} value={until} onChange={event=>setUntil(event.target.value)} className={`${inputCls} min-h-11`}/>
    <span className="block text-xs text-muted-foreground">{t('expiryHelp')}</span></label>
   <label className={label}><span className={caption}>{t('reason')} <span aria-hidden="true" className="text-destructive">*</span></span>
    <textarea name="reason" required minLength={5} maxLength={500} className={`${inputCls} min-h-20`}/></label>
   <p className="text-sm text-muted-foreground">{t('help',{name})}</p>
   {pause.status==='saved'&&<p role="status" className="text-sm font-medium">{t('saved')}</p>}
   {pause.status==='failed'&&<p role="alert" className="text-sm text-destructive">{t('failed')}</p>}
   <div className="flex flex-wrap justify-end gap-2"><ActionButton type="submit" aria-busy={pausing} disabled={pausing} className={button(btnPrimary)}>{t('save')}</ActionButton></div>
  </form>}
  {mode==='required'&&!paused&&!savedUntil&&<p className="text-sm text-muted-foreground">{t('requiredHelp')}</p>}
  {(paused||savedUntil)&&resume.status!=='saved'&&<form className="flex flex-wrap items-center justify-end gap-2" onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);startTransition(()=>resumeAction(form));}}>
   <input type="hidden" name="type" value="recovery-exemption-cancel"/><input type="hidden" name="userId" value={userId}/><input type="hidden" name="confirmed" value="on"/>
   {resume.status==='failed'&&<p role="alert" className="text-sm text-destructive">{t('failed')}</p>}
   <ActionButton type="submit" aria-busy={resuming} disabled={resuming} className={button(btnGhost)}>{t('switchOn')}</ActionButton>
  </form>}
  {resume.status==='saved'&&<p role="status" className="text-sm font-medium">{t('resumed')}</p>}
  <section className="space-y-2 border-t border-border pt-4"><h3 className={caption}>{t('history')}</h3>
   {history.status==='loading'&&<p className="text-sm text-muted-foreground">{t('historyLoading')}</p>}
   {history.status==='failed'&&<p className="text-sm text-muted-foreground">{t('historyFailed')}</p>}
   {history.status==='ok'&&(history.entries.length===0?<p className="text-sm text-muted-foreground">{t('historyEmpty')}</p>:
    <ul className="divide-y divide-border">{history.entries.map((entry,index)=>{
     const text=h(historyLabelKey(entry.event),{until:entry.until?formatDmyTime(entry.until):''});
     return <li key={index} className="grid gap-1 py-2 text-sm sm:grid-cols-[10rem_1fr]"><span className="tabular-nums text-muted-foreground">{formatDmyTime(entry.at)}</span>
      <span>{historyShowsActor(entry.event)&&entry.actor?h('byActor',{event:text,actor:entry.actor}):text}</span></li>;})}</ul>)}
  </section>
 </div>;
}
