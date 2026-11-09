'use client';

import { createContext, useContext, useEffect, useRef, useState, useTransition, type ReactNode, type SyntheticEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

type FilterRequest = { controller: AbortController; timer: ReturnType<typeof setTimeout> };
type Schedule = (form: HTMLFormElement, delay?: number) => void;
type FilterFeedback = { id: string; body: URLSearchParams };
const FilterContext = createContext<{
  schedule: Schedule;
  updating: string | null;
  failed: FilterFeedback | null;
  retry: (failure: FilterFeedback) => void;
} | null>(null);

export function PersonnelAutoFilters({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [working, setWorking] = useState(false);
  const [formId, setFormId] = useState<string | null>(null);
  const [failed, setFailed] = useState<FilterFeedback | null>(null);
  const active = useRef<FilterRequest | null>(null);

  function cancel() {
    if (!active.current) return;
    clearTimeout(active.current.timer);
    active.current.controller.abort();
    active.current = null;
  }

  useEffect(() => cancel, []);

  function send(id: string, readBody: () => URLSearchParams, delay = 0) {
    cancel();
    setFailed(null);
    setWorking(true);
    setFormId(id);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const body = readBody();
      try {
        const response = await fetch('/admin/personnel/search', {
          method: 'POST',
          headers: { Accept: 'application/json' },
          body,
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
        });
        if (!response.ok) throw new Error('Personnel filter request failed');
        const { href } = await response.json() as { href?: string };
        if (!href || !/^\/admin\/personnel(?:\?|$)/.test(href)) throw new Error('Unexpected filter destination');
        if (!controller.signal.aborted) startTransition(() => router.replace(href, { scroll: false }));
      } catch {
        if (!controller.signal.aborted) setFailed({ id, body });
      } finally {
        if (!controller.signal.aborted) setWorking(false);
      }
    }, delay);
    active.current = { controller, timer };
  }

  const schedule: Schedule = (form, delay) => send(form.id, () => {
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(form)) {
      if (typeof value === 'string') body.append(name, value);
    }
    return body;
  }, delay);

  return <FilterContext.Provider value={{
    schedule, updating: working || pending ? formId : null, failed,
    retry: failure => send(failure.id, () => failure.body),
  }}>{children}</FilterContext.Provider>;
}

export function PersonnelFilterFeedback({ formId }: { formId: string }) {
  const filters = useContext(FilterContext);
  const t = useTranslations('personnelOrganisationFilters');
  const failure = filters?.failed;
  return <>
    <span className="sr-only" role="status">{filters?.updating === formId ? t('updatingResults') : ''}</span>
    {failure?.id === formId && <div role="alert" className="space-y-2 rounded-md border border-border p-3 text-sm">
      <p>{t('readBusy')}</p>
      <button className="text-primary underline" type="button" onClick={() => filters?.retry(failure)}>{t('retryRead')}</button>
    </div>}
  </>;
}

export function usePersonnelAutoFilter(formId: string) {
  const schedule = useContext(FilterContext)?.schedule;
  function change(event: SyntheticEvent) {
    const field = event.target;
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement) ||
        !field.name || !field.form || field.form.id !== formId) return;
    if ((event.nativeEvent as InputEvent).isComposing || (field instanceof HTMLInputElement && !field.validity.valid)) return;
    schedule?.(field.form, field instanceof HTMLInputElement && ['text', 'search', 'number'].includes(field.type) ? 300 : 0);
  }
  function submit(event: React.FormEvent<HTMLFormElement>) {
    if (!schedule) return;
    event.preventDefault();
    schedule(event.currentTarget);
  }
  return { change, submit, schedule };
}
