import {Button} from '@/components/ui';

/** A selection from the server-proven own inventory, never an arbitrary employee search. */
export function OwnNoticeEmploymentChoice({subjects,selectedId,action,labels}:{
 subjects:{employmentId:string;company:string;employeeCode:string|null}[];selectedId:string|null;action:string;
 labels:{employment:string;choose:string;show:string;employeeCodeUnavailable:string};
}){
 if(subjects.length<2)return null;
 return <form action={action} method="get" className="flex flex-wrap items-end gap-3">
  <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm font-medium sm:max-w-md">
   {labels.employment}
   <select name="employmentId" required defaultValue={selectedId??''} className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base text-foreground">
    <option value="" disabled>{labels.choose}</option>
    {subjects.map(item=><option key={item.employmentId} value={item.employmentId}>{item.company} · {item.employeeCode??labels.employeeCodeUnavailable}</option>)}
   </select>
  </label>
  <Button type="submit" variant="outline" className="min-h-11">{labels.show}</Button>
 </form>;
}
