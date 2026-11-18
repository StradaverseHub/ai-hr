'use client';
import { useEffect, useId, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { searchOnboardingTaUsers } from './v31-actions';

type User = { id: string; name: string; email: string; department: string };
/** The selected account is case-owned. A legacy typed name is never silently linked by name or email. */
export function OnboardingTaPicker({ caseId, value, selectedName, legacyName, editing, disabled = false, change }: {
  caseId: string; value: string; selectedName?: string; legacyName?: string; editing: boolean; disabled?: boolean; change: (id: string) => void;
}) {
  const t = useTranslations('lifecycle.workflowRecipients');
  const listId = useId(), [query, setQuery] = useState(''), [matches, setMatches] = useState<User[]>([]), [active, setActive] = useState(0), [error, setError] = useState(false), [searched, setSearched] = useState(false), [pending, start] = useTransition();
  const [chosen, setChosen] = useState<User | null>(null);
  useEffect(() => {
    let current = true;
    setMatches([]); setError(false); setSearched(false); setActive(0);
    if (!editing || disabled || query.trim().length < 2) return;
    const timer = setTimeout(() => start(async () => {
      try {
        const result = await searchOnboardingTaUsers(caseId, query);
        if (current) { setMatches(result.users); setError(Boolean(result.error)); setSearched(true); }
      } catch { if (current) { setError(true); setSearched(true); } }
    }), 250);
    return () => { current = false; clearTimeout(timer); };
  }, [caseId, query, editing, disabled]);
  const select = (user: User) => { setChosen(user); change(user.id); setQuery(''); setMatches([]); };
  const name = chosen?.id === value ? chosen.name : selectedName;
  return <div className="v9-stack">
    {value ? <div className="v9-actions"><span>{name || t('taUnavailable')}</span>{editing && <button type="button" className="v9-button" disabled={disabled} onClick={() => { change(''); setChosen(null); }}>{t('clearTa')}</button>}</div>
      : legacyName ? <p className="v9-notice v9-warning" role="status">{t('taNotLinked', { name: legacyName })}</p> : !editing ? <span>{t('taNotSelected')}</span> : null}
    {editing && <><input id="case-field-ta" className="v9-input" type="search" role="combobox" autoComplete="off" aria-label={t('searchTa')} aria-controls={listId} aria-expanded={matches.length > 0} aria-autocomplete="list" aria-activedescendant={matches[active] ? `${listId}-${active}` : undefined} value={query} placeholder={t('searchTaHint')} maxLength={100} disabled={disabled} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
      if (!matches.length) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => (index + 1) % matches.length); }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => (index + matches.length - 1) % matches.length); }
      if (event.key === 'Enter') { event.preventDefault(); select(matches[active]); }
      if (event.key === 'Escape') { event.preventDefault(); setQuery(''); }
    }}/>
      {pending && <p className="v9-muted" role="status">{t('searchingTa')}</p>}
      {error && <p className="v9-error" role="alert">{t('taSearchFailed')}</p>}
      {searched && !pending && !error && !matches.length && <p className="v9-muted" role="status">{t('taNoMatches')}</p>}
      {!!matches.length && <ul id={listId} role="listbox" aria-label={t('taMatches')} className="v9-list">{matches.map((user, index) => <li id={`${listId}-${index}`} key={user.id} role="option" aria-selected={active === index} className={active === index ? 'v9-panel' : undefined} onMouseDown={event => event.preventDefault()} onClick={() => select(user)}><strong>{user.name}</strong><span> · {user.email}{user.department ? ` · ${user.department}` : ''}</span></li>)}</ul>}
    </>}
  </div>;
}
