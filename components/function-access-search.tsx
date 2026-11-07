'use client';

import {useEffect, useRef, useState, type ReactNode} from 'react';

/** Keep the server-authored permission reference intact; filtering changes visibility only. */
export function FunctionAccessSearch({children,label,noResults}:{children:ReactNode;label:string;noResults:string}) {
  const root=useRef<HTMLDivElement>(null);
  const [search,setSearch]=useState('');
  const [matches,setMatches]=useState(true);
  useEffect(()=>{
    const query=search.trim().toLocaleLowerCase();
    let count=0;
    root.current?.querySelectorAll<HTMLTableRowElement>('[data-access-row]').forEach(row=>{
      row.hidden=!(row.dataset.searchText??'').toLocaleLowerCase().includes(query);
      if(!row.hidden)count++;
    });
    setMatches(count>0);
  },[search,children]);
  return <div ref={root} className="space-y-3"><label className="block max-w-md text-sm">{label}<input type="search" value={search} onChange={event=>setSearch(event.target.value)} className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3"/></label>{!matches&&<p role="status" className="text-sm text-muted-foreground">{noResults}</p>}{children}</div>;
}
