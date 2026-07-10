'use client';

// f018ce8d — client half of the Documents tab: the Add-Document form, the searchable/filterable grid, and
// the per-row actions (View / Download / Edit details / Replace attachment / Delete). Data + audit columns
// are pre-formatted server-side (documents-section.tsx); this component owns only presentation + the
// client-side search/filter state. Every mutation posts to a server action (admin-gated + audited there).
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  deleteEmployeeDocumentAction,
  replaceEmployeeDocumentAction,
  updateEmployeeDocumentMetaAction,
  uploadEmployeeDocumentAction,
} from './actions';

export type DocumentVM = {
  id: string;
  title: string;
  category: string | null;
  description: string | null;
  fileName: string;
  mimeType: string;
  typeLabel: string;
  sizeLabel: string;
  uploadedBy: string | null;
  uploadedAt: string;
  updatedBy: string | null;
  updatedAt: string;
  inlineViewable: boolean;
};

// Extensions + mimes accepted by the file inputs (mirrors EMPLOYEE_DOCUMENT_ACCEPT in the service — kept
// as a literal here so this client bundle never pulls in the server-only core module).
const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png,.txt';

const inputCls =
  'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';
const btnPrimary =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 active:scale-[0.98] disabled:opacity-50';
const fileCls =
  'block w-full text-xs text-muted-foreground file:mr-2 file:rounded file:border file:border-border file:bg-muted/40 file:px-2 file:py-1 file:text-xs';

export function DocumentsManager({
  employmentId,
  docs,
  categories,
  types,
}: {
  employmentId: string;
  docs: DocumentVM[];
  categories: string[];
  types: string[];
}) {
  const t = useTranslations('people.detail.documents');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return docs.filter((d) => {
      if (cat && d.category !== cat) return false;
      if (type && d.typeLabel !== type) return false;
      // Uploaded-date filter: uploadedAt is "YYYY-MM-DD HH:MM"; keep rows uploaded on/after the chosen day.
      if (from && d.uploadedAt.slice(0, 10) < from) return false;
      if (needle) {
        const hay = `${d.title} ${d.fileName} ${d.category ?? ''} ${d.uploadedBy ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [docs, q, cat, type, from]);

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Add Document */}
      <details className="rounded-md border border-border bg-muted/20">
        <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">{t('addDocument')}</summary>
        <form action={uploadEmployeeDocumentAction} className="flex flex-col gap-3 border-t border-border p-3">
          <input type="hidden" name="employmentId" value={employmentId} />
          <input type="hidden" name="tab" value="documents" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('fieldTitle')} <span className="text-destructive">*</span>
              <input name="title" required maxLength={200} placeholder={t('fieldTitlePlaceholder')} className={inputCls} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('fieldCategory')}
              <input name="category" list="employee-doc-categories" placeholder={t('fieldCategoryPlaceholder')} className={inputCls} />
              <datalist id="employee-doc-categories">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('fieldDescription')}
            <input name="description" placeholder={t('fieldDescriptionPlaceholder')} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('fieldFile')} <span className="text-destructive">*</span>
            <input type="file" name="file" accept={ACCEPT} required className={fileCls} />
          </label>
          <p className="text-xs text-muted-foreground">{t('supportedTypes')}</p>
          <div>
            <button className={btnPrimary}>{t('upload')}</button>
          </div>
        </form>
      </details>

      {/* Search + filters */}
      {docs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className={`${inputCls} max-w-xs`}
          />
          <select value={cat} onChange={(e) => setCat(e.target.value)} className={`${inputCls} w-auto`}>
            <option value="">{t('allCategories')}</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select value={type} onChange={(e) => setType(e.target.value)} className={`${inputCls} w-auto`}>
            <option value="">{t('allTypes')}</option>
            {types.map((ty) => (
              <option key={ty} value={ty}>
                {ty}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            {t('uploadedFrom')}
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${inputCls} w-auto`} />
          </label>
        </div>
      )}

      {/* Grid */}
      {docs.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : filtered.length === 0 ? (
        <p className="px-1 py-4 text-sm text-muted-foreground">{t('noMatches')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('colTitle')}</th>
                <th className="px-3 py-2 font-medium">{t('colCategory')}</th>
                <th className="px-3 py-2 font-medium">{t('colFile')}</th>
                <th className="px-3 py-2 font-medium">{t('colType')}</th>
                <th className="px-3 py-2 font-medium">{t('colSize')}</th>
                <th className="px-3 py-2 font-medium">{t('colUploaded')}</th>
                <th className="px-3 py-2 font-medium">{t('colUpdated')}</th>
                <th className="px-3 py-2 font-medium">{t('colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((d) => (
                <tr key={d.id} className="align-top">
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-foreground">{d.title}</div>
                    {d.description && <div className="text-xs text-muted-foreground">{d.description}</div>}
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{d.category || '—'}</td>
                  <td className="max-w-40 truncate px-3 py-2.5 font-mono text-xs" title={d.fileName}>
                    {d.fileName}
                  </td>
                  <td className="px-3 py-2.5">{d.typeLabel}</td>
                  <td className="px-3 py-2.5 tabular-nums">{d.sizeLabel}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    <div className="tabular-nums">{d.uploadedAt}</div>
                    <div>{d.uploadedBy || '—'}</div>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    <div className="tabular-nums">{d.updatedAt}</div>
                    <div>{d.updatedBy || '—'}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      {d.inlineViewable && (
                        <a
                          href={`/admin/personnel/${employmentId}/document/${d.id}?inline=1`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary underline-offset-2 hover:underline"
                        >
                          {t('actionView')}
                        </a>
                      )}
                      <a
                        href={`/admin/personnel/${employmentId}/document/${d.id}`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {t('actionDownload')}
                      </a>
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(editing === d.id ? null : d.id);
                          setReplacing(null);
                        }}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {t('actionEdit')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setReplacing(replacing === d.id ? null : d.id);
                          setEditing(null);
                        }}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {t('actionReplace')}
                      </button>
                      <form
                        action={deleteEmployeeDocumentAction}
                        onSubmit={(e) => {
                          if (!confirm(t('confirmDelete'))) e.preventDefault();
                        }}
                      >
                        <input type="hidden" name="employmentId" value={employmentId} />
                        <input type="hidden" name="documentId" value={d.id} />
                        <input type="hidden" name="tab" value="documents" />
                        <button className="text-destructive underline-offset-2 hover:underline">{t('actionDelete')}</button>
                      </form>
                    </div>

                    {editing === d.id && (
                      <form action={updateEmployeeDocumentMetaAction} className="mt-2 flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-2">
                        <input type="hidden" name="employmentId" value={employmentId} />
                        <input type="hidden" name="documentId" value={d.id} />
                        <input type="hidden" name="tab" value="documents" />
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                          {t('fieldTitle')} <span className="text-destructive">*</span>
                          <input name="title" required maxLength={200} defaultValue={d.title} className={inputCls} />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                          {t('fieldCategory')}
                          <input name="category" defaultValue={d.category ?? ''} list="employee-doc-categories" className={inputCls} />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                          {t('fieldDescription')}
                          <input name="description" defaultValue={d.description ?? ''} className={inputCls} />
                        </label>
                        <div>
                          <button className={btnPrimary}>{t('save')}</button>
                        </div>
                      </form>
                    )}

                    {replacing === d.id && (
                      <form action={replaceEmployeeDocumentAction} className="mt-2 flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-2">
                        <input type="hidden" name="employmentId" value={employmentId} />
                        <input type="hidden" name="documentId" value={d.id} />
                        <input type="hidden" name="tab" value="documents" />
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                          {t('replaceHint')}
                          <input type="file" name="file" accept={ACCEPT} required className={fileCls} />
                        </label>
                        <div>
                          <button className={btnPrimary}>{t('actionReplace')}</button>
                        </div>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
