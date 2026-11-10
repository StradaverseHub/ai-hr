'use client';
import {useEffect,useRef} from 'react';
import {useTranslations} from 'next-intl';
import {inputCls} from '@/components/ui';
import type {PersonnelPrivateCriteria} from '@/lib/personnel-list-controls';
import {PersonnelFilterFeedback,usePersonnelAutoFilter} from './auto-filter';
import {PrivateCriteriaFields} from './private-filter-fields';

const emptyCriteria: PersonnelPrivateCriteria = {term: '', filters: []};

/**
 * eaa7697c — the visible "Search employee ID or name…" box beside Filter on the Personnel listing.
 *
 * NOT A SECOND SEARCH. It is another input for the SAME private term the Filter dialog's "Employee ID,
 * name, email or permitted IC / passport" field edits (docs/adr/personnel-organisation-filter-search.md):
 * same POST route, same five-minute principal-bound token, same chip, same request controller
 * (PersonnelAutoFilters) and therefore the same busy/retry feedback. The term never enters a URL.
 *
 * It looks like the profile's EmployeeSwitcher (same keys, same width classes) and matches by the same
 * shared rule (lib/employee-search.ts, applied server-side in createPersonnelPrivateSearch), but it
 * NARROWS the list instead of jumping to a profile, which is what the reporter asked for.
 *
 * Every submission carries the COMPLETE criteria: the route replaces criteria rather than merging, so the
 * ordinary filters, sort and page size travel as hidden fields and every column/employment criterion is
 * re-posted. An empty box therefore removes only the search word.
 *
 * EVERY PROP IS PLAIN DATA (r123): the listing is a server component.
 */
export function PersonnelListSearch({parameters, pageSize, privateCriteria = emptyCriteria}: {
  parameters: [string, string][];
  pageSize?: string;
  privateCriteria?: PersonnelPrivateCriteria;
}) {
  const t = useTranslations('people.switcher');
  const filters = usePersonnelAutoFilter('personnel-list-search');
  const input = useRef<HTMLInputElement>(null);
  // Follow a term changed elsewhere (the Filter dialog, a removed chip) without stealing the value from
  // someone mid-typing. Keying the component by the term would remount the input and drop focus instead.
  useEffect(() => {
    const field = input.current;
    if (field && field !== document.activeElement) field.value = field.defaultValue;
  }, [privateCriteria]);
  return <form id="personnel-list-search" method="post" action="/admin/personnel/search" role="search"
    className="flex flex-col gap-2" onChange={filters.change} onCompositionEnd={filters.change} onSubmit={filters.submit}>
    {/* One non-rendered wrapper, so the hidden spans do not each add a flex gap above the box. */}
    <div className="hidden">
      {pageSize && <input type="hidden" name="size" value={pageSize}/>}
      {parameters.filter(([key]) => !['q', 'search', 'page'].includes(key)).map(([key, value]) =>
        <input key={key} type="hidden" name={key} value={value}/>)}
      <PrivateCriteriaFields criteria={privateCriteria} exclude={['term']}/>
    </div>
    <input ref={input} type="search" name="term" defaultValue={privateCriteria.term} maxLength={200} autoComplete="off"
      aria-label={t('ariaLabel')} placeholder={t('placeholder')} data-tour="personnel-list-search"
      // Same steps as the profile switcher: the header actions group is `shrink-0`, so a fixed width
      // here would scroll the page sideways on a phone.
      className={`${inputCls} h-9 w-52 sm:w-64 md:w-72`}/>
    <PersonnelFilterFeedback formId="personnel-list-search"/>
  </form>;
}
