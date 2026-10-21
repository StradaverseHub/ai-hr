import type {ReactNode} from 'react';
import {Button,PageHeader} from '@/components/ui';
import type {EmployeeHomeIdentity} from '@/lib/employee-home-read-model';
import {readEmployeeHomePreferences,type EmployeeHomeCard} from '@/lib/employee-home';

export type HomeSurfaceLabels={
  title:string;employment:string;chooseEmployment:string;chooseHelp:string;showEmployment:string;
  noEmployment:string;companyUnavailable:string;employeeCodeUnavailable:string;
};

/** Composition only: each supplied card owns its authorized, independently delivered read and
 * canonical actions. Preferences may hide/reorder supplied nodes, never authorize a missing card.
 * This component does not await a combined dashboard payload or infer facts from absent cards.
 */
export function EmployeeHomeSurface({identity,preferences,cards,labels}:{
  identity:EmployeeHomeIdentity;preferences:unknown;
  cards:Partial<Record<EmployeeHomeCard,ReactNode>>;labels:HomeSurfaceLabels;
}){
  const display=readEmployeeHomePreferences(preferences);
  const selected=identity.employments.find(item=>item.employmentId===identity.selectedEmploymentId);
  const ready=identity.employmentState==='selected'&&selected!==undefined;
  const visible=ready?display.cardOrder.filter(card=>!display.hiddenCards.includes(card)&&cards[card]!=null&&cards[card]!==false):[];
  const paired=visible.includes('summary')&&visible.includes('today');
  const width=(card:EmployeeHomeCard)=>{
    if(card==='summary')return paired?'xl:col-span-8':'xl:col-span-12';
    if(card==='today')return paired?'xl:col-span-4':'xl:col-span-12';
    return card==='calendar'||card==='notices'?'xl:col-span-12':'xl:col-span-6';
  };
  return <div data-employee-home className="space-y-6">
    <PageHeader title={labels.title} description={ready?
      (identity.companyEstablished?selected.company:labels.companyUnavailable):undefined}/>
    {identity.employments.length>1&&<form key={`${identity.employmentState}:${identity.selectedEmploymentId??''}`}
      action="/" method="get" className="flex flex-wrap items-end gap-3">
      <label className="flex min-w-0 basis-full flex-1 flex-col gap-2 text-sm font-medium sm:basis-auto sm:max-w-md">
        {labels.employment}
        <select name="employmentId" required defaultValue={ready?selected.employmentId:''}
          aria-describedby={ready?undefined:'home-employment-help'}
          className="min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <option value="" disabled>{labels.chooseEmployment}</option>
          {identity.employments.map(item=><option key={item.employmentId} value={item.employmentId}>
            {item.company} · {item.employeeCode??labels.employeeCodeUnavailable}
          </option>)}
        </select>
      </label>
      <Button type="submit" variant="outline" className="min-h-11">{labels.showEmployment}</Button>
    </form>}
    {!ready&&<p id="home-employment-help" role="status" className="max-w-prose text-sm leading-relaxed text-muted-foreground">
      {identity.employmentState==='none'?labels.noEmployment:labels.chooseHelp}
    </p>}
    {visible.length>0&&<div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
      {visible.map(card=><div key={card} id={`home-card-${card}`} data-home-slot={card} className={`min-w-0 ${width(card)}`}>{cards[card]}</div>)}
    </div>}
  </div>;
}
