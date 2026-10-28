import Link from 'next/link';

/**
 * The Calibration strip above the Talent Box: Performance · Potential · Talent box as segmented tabs. Each tab is a
 * plain link to where that work already lives (talent-box-route.ts decides the targets); the active tab carries
 * aria-current. It scrolls sideways inside itself on a narrow screen rather than widening the page.
 */
export function CalibrationStrip({label,tabs}:{label:string;tabs:{id:string;label:string;href:string;active:boolean}[]}){
 return <nav aria-label={label} className="max-w-full overflow-x-auto">
  <ul className="inline-flex gap-0.5 rounded-[9px] border border-border bg-muted p-[3px]">{tabs.map(tab=><li key={tab.id}>
   <Link href={tab.href} aria-current={tab.active?'page':undefined} data-calibration-tab={tab.id} className={`flex min-h-9 items-center whitespace-nowrap rounded-[7px] px-[15px] text-[0.92rem] ${tab.active?'bg-card font-semibold text-primary shadow-[0_1px_3px_rgba(20,25,50,0.10)]':'font-medium text-muted-foreground hover:bg-card/75 hover:text-primary'}`}>{tab.label}</Link>
  </li>)}</ul>
 </nav>;
}
