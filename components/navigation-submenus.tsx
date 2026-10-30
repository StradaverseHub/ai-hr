'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** One module's named submenus, shared by the inline rail and both flyout themes. */
export function NavigationSubmenus<T extends { href: string; submenuKey?: string }>({ items, isActive, renderItem }: {
  items: T[]; isActive: (href: string) => boolean; renderItem: (item: T, index: number) => ReactNode;
}) {
  const keys = [...new Set(items.map(item => item.submenuKey))];
  return <>{keys.map(key => <NavigationSubmenu key={key ?? 'ungrouped'} labelKey={key} active={items.some(item => item.submenuKey === key && isActive(item.href))}>
    {items.map((item, index) => item.submenuKey === key ? renderItem(item, index) : null)}
  </NavigationSubmenu>)}</>;
}
function NavigationSubmenu({ labelKey, active, children }: { labelKey?: string; active: boolean; children: ReactNode }) {
  const t = useTranslations('nav'), id = useId(), [open, setOpen] = useState(true);
  useEffect(() => { if (active) setOpen(true); }, [active]);
  if (!labelKey) return <>{children}</>;
  return <div className="flex min-w-0 flex-col">
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)} className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm font-medium text-foreground hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
      <span className="min-w-0 flex-1">{t(labelKey)}</span><ChevronDown aria-hidden className={'size-4 shrink-0' + (open ? '' : ' -rotate-90')}/>
    </button>
    <div id={id} hidden={!open} className={(open ? 'flex' : 'hidden') + ' ml-3 min-w-0 flex-col border-l border-border pl-1'}>{children}</div>
  </div>;
}
