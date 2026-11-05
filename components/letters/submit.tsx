'use client';
import {useFormStatus} from 'react-dom';
import {btnPrimary,btnGhost} from '@/components/ui';
export function LetterSubmit({label,pendingLabel,secondary,approval=false}:{label:string;pendingLabel:string;secondary?:boolean;approval?:boolean}){
 const {pending}=useFormStatus();return <button type="submit" className={`${secondary?btnGhost+' border border-border':btnPrimary} min-h-11`} disabled={pending} aria-busy={pending} data-action-pending={pending || undefined} data-action-approval={approval || undefined}>{pending?pendingLabel:label}</button>;
}
