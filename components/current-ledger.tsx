'use client';

import { Fragment, useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import { flushSync } from 'react-dom';
import { useTranslations } from 'next-intl';
import { useUiTheme } from './ui-theme-context';

const narrowQuery = '(max-width: 900px)';
const readNarrow = () => typeof window.matchMedia === 'function' && window.matchMedia(narrowQuery).matches;
const subscribeNarrow = (notify: () => void) => {
  if (typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(narrowQuery);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};
const serverNarrow = () => false;

/** Presentation of an already authorized page projection. Never fetches a record or widens its fields. */
export type LedgerRecord = {
  key: string;
  title: string;
  subtitle: string;
  reference: string;
  status: string;
  fields: { label: string; value: ReactNode }[];
  actions: ReactNode;
  href: string;
};

export function CurrentLedger({ records, label, children, footer }: {
  records: LedgerRecord[];
  label: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const theme = useUiTheme();
  const narrow = useSyncExternalStore(subscribeNarrow, readNarrow, serverNarrow);
  const t = useTranslations('components.current');
  const [tableView, setTableView] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const inspectorId = useId();
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (theme !== 'current') return;
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => { window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after); };
  }, [theme]);
  // Resolve against this render's page, not a retained copy of a record. Scope/filter/page changes
  // cannot leave the old person's fields in the inspector.
  const selected = records.find((r) => r.key === selectedKey) ?? records[0];
  if (theme !== 'current' || !selected || printing) return <>{children}</>;
  const inspector = <aside id={inspectorId} className="current-ledger-inspector" aria-label={t('selectedRecord')}>
      <div className="current-inspector-heading"><span>{t('selectedRecord')}</span><span>{selected.reference}</span></div>
      <h2>{selected.title}</h2><p>{selected.subtitle}</p>
      <dl>{selected.fields.map((field, i) => <div key={i}><dt>{field.label}</dt><dd>{field.value ?? '—'}</dd></div>)}</dl>
      <Link className="current-ledger-open" href={selected.href}>{t('openRecord')}<span aria-hidden>↗</span></Link>
      <div className="current-ledger-actions">{selected.actions}</div>
    </aside>;
  return <div className="current-record-view"><div className="current-record-toolbar" role="group" aria-label={t('view')}>
    <button type="button" aria-pressed={!tableView} onClick={() => setTableView(false)}>{t('ledger')}</button>
    <button type="button" aria-pressed={tableView} onClick={() => setTableView(true)}>{t('table')}</button>
  </div>{tableView ? children : <div className="current-ledger-workspace" data-current-ledger>
    <div className="current-ledger-list" role="group" aria-label={label}>
      <div className="current-ledger-caption"><span>{label}</span><span>{records.length}</span></div>
      {records.map((record) => <Fragment key={record.key}><button type="button"
        className="current-ledger-entry" aria-pressed={record.key === selected.key}
        aria-controls={inspectorId} onClick={() => setSelectedKey(record.key)}>
        <span className="current-ledger-reference">{record.reference}</span>
        <span className="current-ledger-identity"><strong>{record.title}</strong><small>{record.subtitle}</small></span>
        <span className="current-ledger-status">{record.status}<span aria-hidden>↗</span></span>
      </button>{narrow && record.key === selected.key && inspector}</Fragment>)}
    </div>
    {!narrow && inspector}
  </div>}{!tableView && footer}</div>;
}
