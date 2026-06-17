'use client';

/**
 * Persistent in-page section navigation (consultant feedback #4). A sticky left rail (horizontal,
 * scrollable on mobile) that jumps to a section by id and highlights the section currently in view
 * (IntersectionObserver scroll-spy). Used to tame long, single-screen profile pages. Progressive
 * enhancement: without JS the page is the normal scroll; the rail just adds quick navigation.
 */
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export function SectionJumpNav({ sections }: { sections: { id: string; label: string }[] }) {
  const [active, setActive] = useState(sections[0]?.id);

  useEffect(() => {
    const els = sections.map((s) => document.getElementById(s.id)).filter((el): el is HTMLElement => el != null);
    if (els.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-15% 0px -75% 0px', threshold: 0 },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [sections]);

  return (
    <nav
      aria-label="Sections"
      className="flex gap-1 overflow-x-auto rounded-[1.25rem] border border-border bg-card p-1.5 shadow-[var(--shadow-card)] lg:sticky lg:top-2 lg:w-44 lg:shrink-0 lg:flex-col lg:overflow-visible"
    >
      {sections.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          aria-current={active === s.id ? 'true' : undefined}
          // Native hash navigation scrolls the section into view (it correctly handles the app's
          // overflow-auto scroll container, unlike a manual scrollIntoView). setActive just gives the
          // highlight an instant response; the scroll-spy observer keeps it in sync afterwards.
          onClick={() => setActive(s.id)}
          className={cn(
            'whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium transition-colors',
            active === s.id
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}
