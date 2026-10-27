'use client';
import {useFormStatus} from 'react-dom';
import {btnPrimary,btnGhost} from '@/components/ui';
export function LetterSubmit({label,pendingLabel,secondary=false}:{label:string;pendingLabel:string;secondary?:boolean}){
 const {pending}=useFormStatus();return <button type="submit" className={`${secondary?btnGhost+' border border-border':btnPrimary} min-h-11`} disabled={pending} aria-busy={pending}>{pending?pendingLabel:label}</button>;
}
