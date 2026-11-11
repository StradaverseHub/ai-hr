'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import {inputCls} from '@/components/ui';
import type {PersonnelPrivateCriteria} from '@/lib/personnel-list-controls';
import {PersonnelFilterFeedback,usePersonnelAutoFilter} from './auto-filter';
import {PrivateCriteriaFields} from './private-filter-fields';
import {SWITCHER_RESULT_CAP,type SwitcherEmployee} from './employee-search';

const emptyCriteria: PersonnelPrivateCriteria = {term: '', filters: []};
type Suggestions = {query: string; rows: SwitcherEmployee[]; failed?: boolean};

/**
 * eaa7697c — the visible "Search employee ID or name…" box beside Filter on the Personnel listing.
 *
 * NOT A SECOND SEARCH. It is another input for the SAME private term the Filter dialog's "Employee ID,
 * name, email or permitted IC / passport" field edits (docs/adr/personnel-organisation-filter-search.md):
 * same POST route, same five-minute principal-bound token, same chip, same request controller
 * (PersonnelAutoFilters) and therefore the same busy/retry feedback. The term never enters a URL.
 *
 * aa045103 — while typing, a dropdown offers the matching people from the profile switcher's own bounded,
 * authorised reader (GET /api/personnel/search: up to eight rows, the lib/employee-search.ts rule, the
 * session's company scope; it never grants access). It is a suggestion list only: the LIST is narrowed when
 * a person is picked (the term becomes that person's Employee ID), when Enter applies the typed words, or
 * when the box is emptied (only the search word is removed). Typing alone no longer posts a private search
 * per pause, so a keystroke costs one bounded eight-row read and nothing else.
 *
 * Every submission carries the COMPLETE criteria: the route replaces criteria rather than merging, so the
 * ordinary filters, sort and page size travel as hidden fields and every column/employment criterion is
 * re-posted.
 *
 * EVERY PROP IS PLAIN DATA (r123): the listing is a server component.
 */
export function PersonnelListSearch({parameters, pageSize, privateCriteria = emptyCriteria}: {
  parameters: [string, string][];
  pageSize?: string;
  privateCriteria?: PersonnelPrivateCriteria;
}) {
  const t = useTranslations('people.switcher');
  const common = useTranslations('common');
  const filters = usePersonnelAutoFilter('personnel-list-search');
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [response, setResponse] = useState<Suggestions | null>(null);
  // Follow a term changed elsewhere (the Filter dialog, a removed chip) without stealing the value from
  // someone mid-typing. Keying the component by the term would remount the input and drop focus instead.
  useEffect(() => {
    const field = input.current;
    if (field && field !== document.activeElement) field.value = field.defaultValue;
  }, [privateCriteria]);
  // One bounded read per pause in typing; a newer word aborts the older request.
  useEffect(() => {
    const word = query.trim();
    if (!word || word.length > 200) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const result = await fetch('/api/personnel/search?q=' + encodeURIComponent(word), {signal: controller.signal, cache: 'no-store'});
        if (!result.ok) throw new Error('Employee search failed');
        const data = await result.json() as {rows?: SwitcherEmployee[]};
        if (!controller.signal.aborted) setResponse({query: word, rows: Array.isArray(data.rows) ? data.rows.slice(0, SWITCHER_RESULT_CAP) : []});
      } catch {
        if (!controller.signal.aborted) setResponse({query: word, rows: [], failed: true});
      }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  const word = query.trim();
  const current = response?.query === word ? response : null;
  const rows = current?.rows ?? [];
  const loading = !!word && !current;
  const showList = open && !!word;
  // Options: each suggestion, then "Show all matches in the list" (applies the typed words).
  const optionCount = rows.length + (word ? 1 : 0);
  const optionId = (index: number) => `${listId}-option-${index}`;

  const apply = () => {
    const form = input.current?.form;
    setOpen(false);
    setActive(-1);
    if (form) filters.schedule?.(form);
  };
  const pick = (row: SwitcherEmployee) => {
    if (input.current) input.current.value = row.employeeCode || row.name;
    setQuery(input.current?.value ?? '');
    apply();
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { if (showList) { event.preventDefault(); setOpen(false); setActive(-1); } return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!optionCount) return;
      event.preventDefault();
      setOpen(true);
      setActive(index => event.key === 'ArrowDown' ? (index + 1) % optionCount : (index <= 0 ? optionCount : index) - 1);
      return;
    }
    if (event.key === 'Enter' && showList && active >= 0 && active < rows.length) {
      event.preventDefault();
      pick(rows[active]);
    }
    // Enter otherwise submits the form: the typed words are applied (the "Show all" row's action).
  };

  return <form id="personnel-list-search" method="post" action="/admin/personnel/search" role="search"
    className="flex flex-col gap-2" onSubmit={event => { setOpen(false); setActive(-1); filters.submit(event); }}>
    {/* One non-rendered wrapper, so the hidden spans do not each add a flex gap above the box. */}
    <div className="hidden">
      {pageSize && <input type="hidden" name="size" value={pageSize}/>}
      {parameters.filter(([key]) => !['q', 'search', 'page'].includes(key)).map(([key, value]) =>
        <input key={key} type="hidden" name={key} value={value}/>)}
      <PrivateCriteriaFields criteria={privateCriteria} exclude={['term']}/>
    </div>
    <div ref={box} className="relative" onBlur={event => { if (!box.current?.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
      <input ref={input} type="search" name="term" defaultValue={privateCriteria.term} maxLength={200} autoComplete="off"
        role="combobox" aria-autocomplete="list" aria-expanded={showList} aria-controls={showList ? listId : undefined}
        aria-activedescendant={showList && active >= 0 ? optionId(active) : undefined} aria-busy={loading}
        aria-label={t('ariaLabel')} placeholder={t('placeholder')} data-tour="personnel-list-search"
        onChange={event => {
          const value = event.target.value;
          setQuery(value);
          setActive(-1);
          setOpen(true);
          // Emptying the box restores the listing at once (only the search word is removed).
          if (!value.trim() && privateCriteria.term) apply();
        }}
        onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
        // Same steps as the profile switcher: the header actions group is `shrink-0`, so a fixed width
        // here would scroll the page sideways on a phone.
        className={`${inputCls} h-9 w-52 sm:w-64 md:w-72`}/>
      {showList && <div id={listId} role="listbox" aria-label={t('resultsLabel')}
        className="absolute left-0 z-50 mt-1 max-h-96 w-[min(24rem,90vw)] overflow-y-auto rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-lg">
        <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" aria-hidden>{t('matchingHeading')}</p>
        {rows.length === 0 && <p role="status" className="px-3 py-3 text-sm text-muted-foreground">{loading ? common('loading') : current?.failed ? t('loadFailed') : t('noMatches')}</p>}
        {rows.map((row, index) => <div key={row.employmentId} id={optionId(index)} role="option" aria-selected={index === active}
          // mousedown keeps focus in the box, so blur does not close the list before the pick lands.
          onMouseDown={event => event.preventDefault()} onClick={() => pick(row)} onMouseEnter={() => setActive(index)}
          className={`flex cursor-pointer items-center gap-3 px-3 py-2 text-sm ${index === active ? 'bg-muted' : ''}`}>
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{row.name}</span>
          <span className="shrink-0 truncate text-xs text-muted-foreground">{[row.employeeCode, row.department].filter(Boolean).join(' · ')}</span>
        </div>)}
        <div id={optionId(rows.length)} role="option" aria-selected={active === rows.length}
          onMouseDown={event => event.preventDefault()} onClick={apply} onMouseEnter={() => setActive(rows.length)}
          className={`mt-1 cursor-pointer border-t border-border px-3 py-2 text-sm font-medium text-primary ${active === rows.length ? 'bg-muted' : ''}`}>
          {current && !current.failed && rows.length > 0 && rows.length < SWITCHER_RESULT_CAP ? t('showAll', {count: rows.length}) : t('showAllMore')}
        </div>
      </div>}
    </div>
    <PersonnelFilterFeedback formId="personnel-list-search"/>
  </form>;
}
