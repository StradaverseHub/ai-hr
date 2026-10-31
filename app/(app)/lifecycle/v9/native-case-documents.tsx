'use client';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import type { Actor, Case, Config } from '@/lib/lifecycle-v9-model';
import { matches, currentVersion, canRegenerate } from '@/lib/lifecycle-v9-model';
import type { LifecycleV9Command } from '@/packs/lifecycle/service';
import { commandV9, readV9Case } from './actions';
import { CaseFiles } from './case-files';
import { CaseDocument } from './case-document';
import { PersonnelReview } from './personnel-review';
import { CaseMailHistory } from './mail-history';
import { CaseWorkflows } from './case-workflows';
import { CaseEmails } from './email-composer';

export function NativeCaseDocuments({ initial, config, actor, writableKeys, users = [], eligibleSignatoryIds }: { initial: Case; config: Config; actor: Actor; writableKeys: string[]; users?:{id:string;name:string}[]; eligibleSignatoryIds?:string[] }) {
  const [c, setCase] = useState(initial), [selected, select] = useState<string | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, start] = useTransition();
  const router = useRouter(), dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { setCase(previous => initial.revision >= previous.revision ? initial : previous); }, [initial]);
  useEffect(() => { if (selected && !dialog.current?.open) dialog.current?.showModal(); }, [selected]);
  const document = c.documents.find(document => document.id === selected);
  const templates = config.templates.filter(template => template.module === 'onb' && !template.retired && currentVersion(template) && matches(template.rules, c.facts));
  function command(value: LifecycleV9Command): Promise<{ ok: boolean; error?: string }> {
    setError(''); setNotice('');
    return new Promise(resolve => start(async () => {
      try {
        const result = await commandV9(c.id, c.revision, value);
        if (!result.ok) { setError(result.error); resolve(result); return; }
        const refreshed = await readV9Case(c.id);
        if (!refreshed.ok) { setError(refreshed.error); resolve(refreshed); return; }
        setCase(refreshed.detail.case); if(value.type==='documentSign')select(null); setNotice(value.type === 'emailSend' || value.type === 'emailTest' ? 'Email queued for delivery.' : 'Changes saved.'); router.refresh(); resolve({ ok: true });
      } catch { const result = { ok: false, error: 'The change could not be saved. Refresh and try again.' }; setError(result.error); resolve(result); }
    }));
  }
  return <section className="v9-workspace v9-native-documents" aria-label="Onboarding documents"><div className="v9-stack">
    {error && <p role="alert" className="v9-notice v9-error">{error}</p>}{notice && <p role="status" className="v9-notice">{notice}</p>}
    <section className="v9-panel v9-stack"><div className="v9-heading"><h2>Documents</h2><span className="v9-muted">{c.number}</span></div>
      {!c.documents.length && <p className="v9-muted">No documents generated yet.</p>}
      <ul className="v9-list">{c.documents.map(document => <li key={document.id}><div className="v9-heading"><div><strong>{document.name}</strong><p className="v9-muted">v{document.version} · {document.status}</p></div><button type="button" className="v9-button" onClick={() => select(document.id)}>Open {document.name}</button>{canRegenerate(c,document) && <button type="button" className="v9-button" disabled={busy} onClick={() => void command({type: 'documentRegenerate', id: document.id})}>Regenerate {document.name}</button>}</div></li>)}</ul>
      <div className="v9-actions">{templates.map(template => <button key={template.id} type="button" className="v9-button" disabled={busy || c.state !== 'submitted'} onClick={() => void command({ type: 'generate', template: template.id })}>Generate {template.name}</button>)}</div>
      {c.state === 'pending' && <p className="v9-notice">Submit the onboarding case to start its documents.</p>}
    </section>
    <PersonnelReview c={c} busy={busy} writableKeys={writableKeys} command={value => void command(value)}/>
    <CaseFiles key={c.id} c={c} config={config} readOnly/>
    <CaseWorkflows c={c} config={config} busy={busy} command={command}/>
    <CaseEmails c={c} config={config} busy={busy} command={command}/><CaseMailHistory caseId={c.id} mails={c.mails} open={c.state === 'submitted'} busy={busy} command={command}/>
    {document && <dialog className="v9-dialog" aria-label={document.name} ref={dialog} onCancel={() => select(null)}><header><h2>{document.name}</h2><button type="button" className="v9-button" aria-label="Close document" onClick={() => select(null)}><X size={18}/></button></header><CaseDocument key={`${document.id}:${c.revision}`} c={c} document={document} eligibleSignatoryIds={eligibleSignatoryIds} template={config.templates.find(template => template.id === document.templateId)} actor={actor} config={config} users={users} busy={busy} command={command}/></dialog>}
  </div></section>;
}
