'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';

/** Exact existing captions and tips, available through hover, focus and touch. */
export function InquiryNote({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  return <span ref={root} className="relative inline-flex align-middle" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" aria-label={label} aria-expanded={open} onFocus={() => setOpen(true)} onClick={() => setOpen(!open)} className="inline-flex min-h-7 min-w-7 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"><Info className="size-3.5" aria-hidden /></button>
    {open && <span role="note" className="absolute left-0 top-full z-50 block w-64 max-w-[80vw] whitespace-normal rounded-md border border-border bg-popover p-3 text-left text-xs font-normal text-popover-foreground shadow-lg">{children}</span>}
  </span>;
}
