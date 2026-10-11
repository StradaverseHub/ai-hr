'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from '@/components/ui';
import { readDescription } from '@/packs/rewards/document-reader';
import { compareRoleDescriptions } from '@/packs/rewards/role-summary';


export function RoleComparison({ current, proposed }: { current: string; proposed: string }) {
  const t = useTranslations('rewards');
  const [sources, setSources] = useState({ current: '', proposed: '' });
  const [summaries, setSummaries] = useState({ current, proposed });
  const [busy, setBusy] = useState({ current: false, proposed: false });
  const sequence = useRef({ current: 0, proposed: 0 });
  const [error, setError] = useState(''), [result, setResult] = useState<ReturnType<typeof compareRoleDescriptions> | null>(null);
  async function read(side: 'current' | 'proposed', file?: File) {
    if (!file) return;
    const seq = ++sequence.current[side]; setBusy(s => ({ ...s, [side]: true })); setError('');
    try { const text = await readDescription(file); if (seq === sequence.current[side]) { setSources(s => ({ ...s, [side]: text })); setResult(null); } }
    catch { if (seq === sequence.current[side]) setError(t('descriptionReadError')); }
    finally { if (seq === sequence.current[side]) setBusy(s => ({ ...s, [side]: false })); }
  }
  function compare() {
    setError('');
    try {
      const comparison = compareRoleDescriptions(sources.current, sources.proposed);
      if (comparison.identical) { setError(t('identicalDescriptions')); return; }
      setResult(comparison); setSummaries({ current: comparison.currentSummary, proposed: comparison.proposedSummary });
      setSources({ current: '', proposed: '' });
    } catch { setError(t('descriptionReadError')); }
  }
  return <section className="space-y-4 rounded-md border border-border p-4">
    <h2 className="font-semibold">{t('roleComparison')}</h2><p className="text-sm text-muted-foreground">{t('roleComparisonHelp')}</p>
    <div className="grid gap-4 sm:grid-cols-2">{(['current', 'proposed'] as const).map(side => <div key={side} className="space-y-3"><Field label={t(side === 'current' ? 'currentDescription' : 'proposedDescription')}><input type="file" accept=".docx,.pdf,.txt,.md" onChange={e => void read(side, e.target.files?.[0])} className="block w-full text-sm" /></Field><textarea aria-label={t('pasteDescription')} maxLength={30000} rows={5} value={sources[side]} onChange={e => { sequence.current[side]++; setBusy(s => ({ ...s, [side]: false })); setSources(s => ({ ...s, [side]: e.target.value })); setResult(null); }} placeholder={t('pasteDescription')} className={`${inputCls} h-auto py-2`} />{busy[side] && <p role="status" className="text-sm">{t('readingDescription')}</p>}</div>)}</div>
    <Button type="button" variant="secondary" disabled={busy.current || busy.proposed || !sources.current || !sources.proposed} onClick={compare}>{t('compareDescriptions')}</Button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {result && <p role="status" className="text-sm">{t('comparisonCounts', { added: result.added.length, removed: result.removed.length, unchanged: result.unchanged.length })}</p>}
    <div className="grid gap-4 sm:grid-cols-2">{(['current', 'proposed'] as const).map(side => <Field key={side} label={t(side === 'current' ? 'currentRoleSummary' : 'proposedRoleSummary')}><textarea name={side === 'current' ? 'currentRoleSummary' : 'proposedRoleSummary'} rows={6} maxLength={8000} value={summaries[side]} onChange={e => setSummaries(s => ({ ...s, [side]: e.target.value }))} className={`${inputCls} h-auto py-2`} /></Field>)}</div>
    <p className="text-sm text-muted-foreground">{t('roleSummaryHelp')}</p>
  </section>;
}
