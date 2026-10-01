'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { AnchoredPanel, useAnchoredPanel } from '@/components/ui/anchored-panel';

/** Exact existing captions and tips, available through hover, focus and touch. */
export function InquiryNote({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const { at, anchorTo } = useAnchoredPanel({open, onClose: () => setOpen(false), width:256, flipHeight:160});
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  return <span ref={root} className="relative inline-flex align-middle" onMouseEnter={() => { if (root.current) anchorTo(root.current); setOpen(true); }} onMouseLeave={() => setOpen(false)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" aria-label={label} aria-expanded={open} onFocus={() => { if (root.current) anchorTo(root.current); setOpen(true); }} onClick={() => setOpen(!open)} className="inline-flex min-h-7 min-w-7 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"><Info className="size-3.5" aria-hidden /></button>
    {open && <AnchoredPanel at={at} role="note" className="w-64 whitespace-normal text-xs font-normal text-popover-foreground">{children}</AnchoredPanel>}
  </span>;
}
