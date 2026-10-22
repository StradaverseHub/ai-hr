'use client';

import * as React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {useLocale,useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import type {HomeCelebration} from '@/lib/employee-home-sharing';
import {HOME_GREETING_MAX_CHARACTERS,homeGreetingMessage,validateHomeGreetingCommand,
 validateHomeGreetingReceipt,type HomeGreetingCommand,type HomeGreetingReceipt} from '@/lib/employee-home-greeting';

type Props={employmentId:string;target:HomeCelebration;send:(command:Readonly<HomeGreetingCommand>)=>Promise<unknown>};
/** UI only. The canonical sender must be supplied explicitly after the private SQL owner is installed;
 * opening, editing and cancelling have no side effect. A subject/occasion change drops the old draft. */
export function HomeGreetingComposer(props:Props){
 return <Composer key={JSON.stringify([props.employmentId,props.target.employmentId,props.target.kind,props.target.date])} {...props}/>;
}
function Composer({employmentId,target,send}:Props){
 const t=useTranslations('employeeHome.greetingSend'),locale=useLocale(),fieldId=React.useId(),helpId=React.useId();
 const name=target.name??t('unnamed');
 const [open,setOpen]=React.useState(false);
 const [message,setMessage]=React.useState(()=>t(target.kind==='birthday'?'birthdayMessage':'anniversaryMessage',{name}));
 const [pending,setPending]=React.useState(false),[uncertain,setUncertain]=React.useState(false);
 const [locked,setLocked]=React.useState(false);
 const [invalid,setInvalid]=React.useState(false),[receipt,setReceipt]=React.useState<HomeGreetingReceipt|null>(null);
 const attempted=React.useRef<Readonly<HomeGreetingCommand>|null>(null),busy=React.useRef(false),mounted=React.useRef(true);
 React.useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 let valid=true;try{homeGreetingMessage(message);}catch{valid=false;}
 const date=new Intl.DateTimeFormat(locale,{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(target.date+'T00:00:00Z'));
 async function submit(event:React.FormEvent){
  event.preventDefault();if(busy.current||receipt)return;
  let command:Readonly<HomeGreetingCommand>;
  try{
   command=attempted.current??Object.freeze(validateHomeGreetingCommand({version:1,employmentId,
    recipientEmploymentId:target.employmentId,kind:target.kind,occurrenceDate:target.date,
    nonce:crypto.randomUUID(),message}));
  }catch{setInvalid(true);return;}
  // Freeze the exact attempted body as well as its nonce. An ambiguous response cannot authorize
  // editing and retrying a different command under that nonce or silently sending a second message.
  attempted.current=command;busy.current=true;setLocked(true);setPending(true);setUncertain(false);setInvalid(false);
  try{
   const result=validateHomeGreetingReceipt(await send(command),command);
   if(mounted.current)setReceipt(result);
  }catch{if(mounted.current)setUncertain(true);}
  finally{busy.current=false;if(mounted.current)setPending(false);}
 }
 return <Dialog.Root open={open} onOpenChange={setOpen}>
  <Dialog.Trigger asChild><Button type="button" variant="outline" className="min-h-11 whitespace-normal">
   {t(target.kind==='birthday'?'sayHi':'cheer')}
  </Button></Dialog.Trigger>
  <Dialog.Portal>
   <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/>
   <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-5 text-foreground shadow-xl">
    <Dialog.Title className="text-lg font-semibold">{t('title')}</Dialog.Title>
    <Dialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">{t('help')}</Dialog.Description>
    <p className="mt-4 text-sm [overflow-wrap:anywhere]">{t('recipient',{name})} · <time dateTime={target.date}>{date}</time></p>
    <form onSubmit={submit} className="mt-4 space-y-4">
     <div className="space-y-2">
      <label htmlFor={fieldId} className="block text-sm font-medium">{t('message')}</label>
      <textarea id={fieldId} value={message} onChange={event=>{setMessage(event.target.value);setInvalid(false);}}
       readOnly={locked} rows={5} maxLength={2*HOME_GREETING_MAX_CHARACTERS}
       aria-describedby={helpId} aria-invalid={invalid||!valid}
       className="w-full resize-y rounded-lg border border-border bg-background p-3 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"/>
      <p id={helpId} className="text-xs text-muted-foreground">{t('count',{count:Array.from(message).length,max:HOME_GREETING_MAX_CHARACTERS})}</p>
     </div>
     {invalid&&<p role="alert" className="text-sm">{t('invalid',{max:HOME_GREETING_MAX_CHARACTERS})}</p>}
     {uncertain&&<div role="alert" className="space-y-2 rounded-lg border border-border p-3 text-sm leading-relaxed">
      <p>{t('uncertain')}</p><p>{t('sameRetry')}</p>
     </div>}
     {receipt&&<p role="status" className="rounded-lg border border-border p-3 text-sm">{t(receipt.state==='erased'?'erased':'sent')}</p>}
     <div className="flex flex-wrap justify-end gap-3">
      <Dialog.Close asChild><Button type="button" variant="outline" className="min-h-11">{t(locked?'close':'cancel')}</Button></Dialog.Close>
      {!receipt&&<Button type="submit" className="min-h-11" disabled={pending||!valid}>
       {t(pending?'sending':uncertain?'retry':'send')}
      </Button>}
     </div>
    </form>
   </Dialog.Content>
  </Dialog.Portal>
 </Dialog.Root>;
}
