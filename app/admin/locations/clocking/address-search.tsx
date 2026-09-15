'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { btnGhost, inputCls } from '@/components/ui';
import { geocodeRequestUrl, parseGeocodeResults, type GeocodeResult, type MapProvider } from './map-provider';
import { ownerForm, requestMapFocus, setFieldValue } from './form-bridge';

/**
 * fa2db8cb rev 2 (r279) — ADDRESS SEARCH at the top of the Clocking Location form.
 *
 * Type a building, street or landmark, press Search, pick the right hit, and `address`, `lat` and `lng`
 * fill themselves in. It writes those three inputs of the enclosing server-rendered form and owns none
 * of them (./form-bridge.ts says why), so a refused save still echoes back exactly what was typed and
 * the coordinates stay editable by hand afterwards.
 *
 * ⚠️ ON SUBMIT ONLY, NEVER ON KEYSTROKE. The free geocoder's usage policy forbids search-as-you-type,
 * so there is no debounce here and there must never be one: `onChange` updates a local string and
 * nothing else. The only two things that can start a request are the Search button and Enter in the
 * box. Results are not cached, which the same policy also asks for.
 *
 * ⚠️ TWO SUBMIT TRAPS, both of which would have posted a half-filled form to `createClockingLocation`.
 * A `<button>` inside a `<form>` defaults to `type="submit"`, so Search MUST say `type="button"`; and
 * Enter in a text box submits the enclosing form by default, so the key handler preventDefaults before
 * it searches. The search box carries NO `name` either — an unnamed control is not submitted, which is
 * what keeps CLOCKING_FIELDS (./form-fields.ts) the exact set of eight the action reads.
 *
 * NO KEY REQUIRED and no key read: the endpoint arrives as a resolved string on `provider`, from the
 * seam in ./map-provider.ts. The query leaves the browser for the map supplier — true of the free
 * supplier and of every paid one — which is why the attribution line under the box names who answered.
 */
type SearchState =
  | { status: 'idle' }
  | { status: 'empty' }
  | { status: 'searching' }
  | { status: 'results'; results: GeocodeResult[] }
  | { status: 'none' }
  | { status: 'failed' }
  | { status: 'picked'; label: string };

export function ClockingAddressSearch({ provider }: { provider: MapProvider }) {
  const t = useTranslations('admin.locations');
  const hostRef = useRef<HTMLDivElement>(null);
  /** Monotonic request id: a slow first answer must never overwrite a faster second one. */
  const requestSeq = useRef(0);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'idle' });

  async function runSearch() {
    const q = query.trim();
    if (q === '') {
      setState({ status: 'empty' });
      return;
    }
    const seq = ++requestSeq.current;
    setState({ status: 'searching' });
    try {
      const res = await fetch(geocodeRequestUrl(provider, q), { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) throw new Error(`geocoder answered ${res.status}`);
      const results = parseGeocodeResults(await res.json());
      if (seq !== requestSeq.current) return;
      setState(results.length > 0 ? { status: 'results', results } : { status: 'none' });
    } catch {
      // The free supplier offers no availability guarantee. A failure says so and points at the boxes
      // below, which still work — it never blocks the save.
      if (seq === requestSeq.current) setState({ status: 'failed' });
    }
  }

  function pick(result: GeocodeResult) {
    const form = ownerForm(hostRef.current);
    setFieldValue(form, 'address', result.label);
    setFieldValue(form, 'lat', result.lat);
    setFieldValue(form, 'lng', result.lng);
    requestMapFocus(form);
    setState({ status: 'picked', label: result.label });
  }

  return (
    <div ref={hostRef} className="border-b border-border p-4">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('addressSearchLabel')}</span>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            void runSearch();
          }}
          placeholder={t('addressSearchPlaceholder')}
          aria-label={t('addressSearchLabel')}
          maxLength={300}
          className={`${inputCls} min-w-0 flex-1 sm:max-w-md`}
        />
        <button type="button" onClick={() => void runSearch()} disabled={state.status === 'searching'} className={btnGhost}>
          {state.status === 'searching' ? t('addressSearchSearching') : t('addressSearchButton')}
        </button>
      </div>

      <p className="mt-1.5 text-xs text-muted-foreground">{t('addressSearchHint')}</p>

      {state.status === 'results' && (
        <ul className="mt-2 divide-y divide-border overflow-hidden rounded-md border border-border" aria-label={t('addressSearchResults')}>
          {state.results.map((r) => (
            <li key={`${r.lat},${r.lng},${r.label}`}>
              <button
                type="button"
                onClick={() => pick(r)}
                className="block w-full px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <span className="block">{r.label}</span>
                <span className="block text-xs tabular-nums text-muted-foreground">
                  {r.lat}, {r.lng}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {state.status === 'empty' && <p className="mt-2 text-xs text-muted-foreground">{t('addressSearchEmpty')}</p>}
      {state.status === 'none' && <p className="mt-2 text-xs text-muted-foreground">{t('addressSearchNoResults')}</p>}
      {state.status === 'failed' && <p className="mt-2 text-xs text-destructive">{t('addressSearchFailed')}</p>}
      {state.status === 'picked' && <p className="mt-2 text-xs text-muted-foreground">{t('addressSearchPicked')}</p>}

      <p className="mt-2 text-[11px] text-muted-foreground">{provider.geocodeAttribution}</p>
    </div>
  );
}
