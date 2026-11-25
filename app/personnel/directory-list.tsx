'use client';

/**
 * The People directory's list-only island (ADR 0181 Phase 4). A filter, chip, page-size or pager step fetches the
 * list from POST /personnel/list and replaces only these parts: the count beside the title, the chips, the pager and
 * the table. The frame and the rest of the page are not rendered again and none of the page's other reads run. The
 * address follows with history.pushState (Back and Forward re-read the list for that address), so a copied link
 * still opens the same view through the ordinary page render. If the list cannot be read (signed out, offline, a
 * server error) the island falls back to an ordinary navigation to that address, which fails closed on the page.
 */
import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Avatar, EmployeeCode, StatusBadge, pagerStepCls, pagerStepMutedCls } from '@/components/ui';
import { FilterChips, FilterPanel, type FilterField, type FilterPanelLabels } from '@/components/filter-panel';
import { PageSizeSelect } from '@/components/page-size-select';
import type { DirectoryLinkView, DirectoryView } from './directory-view';

type DirectoryList = { view: DirectoryView; pending: boolean; navigate: (href: string) => void };
const Context = createContext<DirectoryList | null>(null);
const useDirectoryList = () => {
  const value = useContext(Context);
  if (!value) throw new Error('DirectoryList parts must sit inside DirectoryListProvider');
  return value;
};

/** The address's directory parameters as the list endpoint's JSON body. */
function bodyFor(href: string) {
  const url = new URL(href, window.location.origin);
  return JSON.stringify(Object.fromEntries(url.searchParams));
}

export function DirectoryListProvider({ initial, children }: { initial: DirectoryView; children: ReactNode }) {
  const [view, setView] = useState(initial);
  const [pending, setPending] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const load = useCallback(async (href: string, history: 'push' | 'none') => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setPending(true);
    try {
      const response = await fetch('/personnel/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bodyFor(href),
        signal: controller.signal,
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as DirectoryView;
      if (controller.signal.aborted) return;
      setView(next);
      if (history === 'push') window.history.pushState(null, '', next.href);
    } catch (error) {
      if (controller.signal.aborted) return;
      // Fail closed through the ordinary page render, which owns sign-in and error handling.
      window.location.assign(href);
      void error;
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setPending(false);
      }
    }
  }, []);
  const navigate = useCallback((href: string) => void load(href, 'push'), [load]);
  useEffect(() => {
    const onPop = () => void load(window.location.pathname + window.location.search, 'none');
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      inFlight.current?.abort();
    };
  }, [load]);
  return <Context.Provider value={{ view, pending, navigate }}>{children}</Context.Provider>;
}

/** The count beside the title and the Filter button. */
export function DirectoryHeaderActions({ fields, labels }: { fields: FilterField[]; labels: Omit<FilterPanelLabels, 'activeCount'> & { activeCount: Record<number, string> } }) {
  const { view, navigate } = useDirectoryList();
  const values = view.filters;
  const active = Object.values(values).filter(Boolean).length;
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground" data-directory-count>{view.headerCount}</span>
      {/* Keyed by the address so the uncontrolled inputs show the applied values after each list read. */}
      <FilterPanel key={view.href} action="/personnel" fields={fields} values={values} onNavigate={navigate}
        labels={{ ...labels, activeCount: labels.activeCount[active] ?? labels.activeCount[0] }} />
    </div>
  );
}

export function DirectoryChips({ fields, labels }: { fields: FilterField[]; labels: Omit<FilterPanelLabels, 'activeCount'> & { activeCount: Record<number, string> } }) {
  const { view, navigate } = useDirectoryList();
  const active = Object.values(view.filters).filter(Boolean).length;
  return <FilterChips action="/personnel" fields={fields} values={view.filters} onNavigate={navigate}
    labels={{ ...labels, activeCount: labels.activeCount[active] ?? labels.activeCount[0] }} />;
}

function Step({ link, onNavigate }: { link: DirectoryLinkView; onNavigate: (href: string) => void }) {
  if (!link.href) return <span className={pagerStepMutedCls}>{link.label}</span>;
  const href = link.href;
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; // a new tab opens the page itself
    e.preventDefault();
    onNavigate(href);
  };
  return <Link href={href} onClick={go} className={pagerStepCls}>{link.label}</Link>;
}

function IconStep({ href, label, onNavigate, children }: { href: string | null; label: string; onNavigate: (href: string) => void; children: ReactNode }) {
  if (!href) return <button type="button" disabled aria-label={label}>{children}</button>;
  return (
    <Link href={href} aria-label={label} title={label} onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      onNavigate(href);
    }}>{children}</Link>
  );
}

export function DirectoryTable({ columns, theme }: { columns: { code: string; name: string; department: string; company: string; status: string; hired: string }; theme: string }) {
  const { view, pending, navigate } = useDirectoryList();
  const { pager } = view;
  return (
    <div aria-busy={pending || undefined} data-directory-list>
      {theme === 'atelier' ? (
        <div data-ui-pager data-ui-pager-compact className="atelier-pager">
          {pager.truncatedText && <p className="atelier-pager-note">{pager.truncatedText}</p>}
          <PageSizeSelect label={pager.rowsPerPage} value={pager.size} options={pager.sizeOptions} onNavigate={navigate} />
          <span className="atelier-pager-range">{pager.compactRange}</span>
          {pager.countExactly?.href && (
            <Link href={pager.countExactly.href} data-pager-count-exactly className="text-xs text-primary hover:underline"
              onClick={(e) => { e.preventDefault(); navigate(pager.countExactly!.href!); }}>
              {pager.countExactly.label}
            </Link>
          )}
          <span className="atelier-pager-steps">
            <IconStep href={pager.prev.href} label={pager.previousPage} onNavigate={navigate}><ChevronLeft aria-hidden /></IconStep>
            <IconStep href={pager.next.href} label={pager.nextPage} onNavigate={navigate}><ChevronRight aria-hidden /></IconStep>
          </span>
        </div>
      ) : (
      <div data-ui-pager className="border-b border-border">
        {pager.truncatedText && <p className="border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">{pager.truncatedText}</p>}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <PageSizeSelect label={pager.rowsPerPage} value={pager.size} options={pager.sizeOptions} onNavigate={navigate} />
          <span className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
            {pager.rangeText}
            {pager.countExactly?.href && (
              <Link href={pager.countExactly.href} data-pager-count-exactly className="text-xs text-primary hover:underline"
                onClick={(e) => { e.preventDefault(); navigate(pager.countExactly!.href!); }}>
                {pager.countExactly.label}
              </Link>
            )}
          </span>
          <div className="flex items-center gap-2 text-sm">
            <Step link={pager.first} onNavigate={navigate} />
            <Step link={pager.prev} onNavigate={navigate} />
            <Step link={pager.next} onNavigate={navigate} />
            <Step link={pager.last} onNavigate={navigate} />
          </div>
        </div>
      </div>
      )}
      <table className={`w-full text-sm${pending ? ' opacity-60' : ''}`}>
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">{columns.code}</th>
            <th className="px-4 py-3 font-medium">{columns.name}</th>
            <th className="px-4 py-3 font-medium">{columns.department}</th>
            <th className="px-4 py-3 font-medium">{columns.company}</th>
            <th className="px-4 py-3 font-medium">{columns.status}</th>
            <th className="px-4 py-3 font-medium">{columns.hired}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {view.rows.map((e) => (
            <tr key={e.employmentId} className="hover:bg-muted/40">
              <td className="px-4 py-3"><EmployeeCode code={e.employeeCode} /></td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <Avatar name={e.name} src={e.photoUrl ?? undefined} />
                  <div className="min-w-0">
                    <Link href={`/personnel/${e.employmentId}`} className="font-medium text-foreground hover:text-primary">{e.name}</Link>
                    <div className="truncate text-xs text-muted-foreground">{e.email}</div>
                  </div>
                </div>
              </td>
              <td className="px-4 py-3 text-muted-foreground">{e.department ?? '—'}</td>
              <td className="px-4 py-3 text-muted-foreground">{e.company}</td>
              <td className="px-4 py-3"><StatusBadge status={e.status} label={e.statusLabel} /></td>
              <td className="px-4 py-3 text-muted-foreground">{e.hiredOn}</td>
            </tr>
          ))}
          {view.emptyText && (
            <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">{view.emptyText}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
