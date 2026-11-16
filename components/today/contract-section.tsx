import Link from 'next/link';
import {FileSignature,ArrowRight} from 'lucide-react';

export type ContractHomeItem=Readonly<{id:string;subjectName:string;linkPath:string}>;
/** The owner supplies its exact total and a bounded preview; the preview length never becomes the count. */
export function ContractSection({items,total,title,countLabel,signLabel,allLabel}:{items:readonly ContractHomeItem[];total:number;title:string;countLabel:string;signLabel:string;allLabel:string}){
 if(total===0)return null;
 return <section data-today-contract data-contract-total={total} aria-labelledby="today-contract-heading" className="min-w-0 rounded-2xl border border-border bg-card p-5">
  <header className="flex flex-wrap items-center justify-between gap-3">
   <div className="flex min-w-0 items-start gap-3"><FileSignature aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-muted-foreground"/><div><h2 id="today-contract-heading" className="m-0 text-base font-semibold">{title}</h2><p className="m-0 mt-1 text-sm text-muted-foreground">{countLabel}</p></div></div>
   <Link href="/tasks?contractPage=1" className="inline-flex min-h-11 items-center gap-2 rounded-md text-sm font-medium underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">{allLabel}<ArrowRight aria-hidden="true" size={16}/></Link>
  </header>
  <ul className="m-0 mt-4 list-none divide-y divide-border p-0">{items.map(item=><li key={item.id} data-contract-home-item><Link href={item.linkPath} className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md py-3 text-sm underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"><span className="min-w-0 break-words font-medium">{item.subjectName}</span>{' '}<span className="shrink-0 text-muted-foreground">{signLabel}</span></Link></li>)}</ul>
 </section>;
}
