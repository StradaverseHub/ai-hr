'use client';
import {useFormStatus} from 'react-dom';
import {Button} from '@/components/ui';
export function WorkforceSubmit({label,pendingLabel,archive=false}:{label:string;pendingLabel:string;archive?:boolean}){
 const {pending}=useFormStatus();
 return <Button type="submit" variant={archive?'destructive':'default'} disabled={pending} aria-disabled={pending}>{pending?pendingLabel:label}</Button>;
}
