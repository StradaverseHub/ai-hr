'use client';

// f018ce8d — client half of the Documents tab: the Add-Document dialog, the searchable/filterable grid, and
// the per-row actions (View / Download / Edit details / Replace attachment / Delete). Data + audit columns
// are pre-formatted server-side (documents-section.tsx); this component owns only presentation + the
// client-side search/filter state. Every mutation posts to a server action (admin-gated + audited there).
//
// 0386b95d — the tab now wears the QUALIFICATION shape (page.tsx `qualificationPanel`): an Add button in a
// header strip, Add/Edit/Replace as FamilyFormDialog pop-ups, and a plain table underneath. It used to open
// Add as a <details>/<summary> fold-out — the only disclosure on the whole personnel page — with Edit and
// Replace as inline panels that pushed the grid around. Nothing about the upload path, the mime/size
// validation, the storage call or the delete gate changed; this is presentation only.
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FamilyFormDialog } from '@/components/family-form-dialog';
import { Button } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
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
const labelCls = 'flex flex-col gap-1 text-xs text-muted-foreground';

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

  // Add (d null) and Edit share one field block so the two dialogs can never drift apart. The STATIC hidden
  // `tab` input is load-bearing: Dialog.Portal reparents the form to document.body, outside the
  // PersonnelTabs shell, so the shell's capture-phase submit listener never sees it and cannot inject the
  // tab — without this input every save would land back on the Profile tab (same note as the Family and
  // Qualification dialogs in page.tsx).
  const documentDialogForm = (d: DocumentVM | null) => (
    <form
      action={d ? updateEmployeeDocumentMetaAction : uploadEmployeeDocumentAction}
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="employmentId" value={employmentId} />
      {d && <input type="hidden" name="documentId" value={d.id} />}
      <input type="hidden" name="tab" value="documents" data-tab-tracker="" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={labelCls}>
          {t('fieldTitle')} <span className="text-destructive">*</span>
          <input
            name="title"
            required
            maxLength={200}
            defaultValue={d?.title ?? ''}
            placeholder={t('fieldTitlePlaceholder')}
            className={inputCls}
          />
        </label>
        <label className={labelCls}>
          {t('fieldCategory')}
          <input
            name="category"
            list="employee-doc-categories"
            defaultValue={d?.category ?? ''}
            placeholder={t('fieldCategoryPlaceholder')}
            className={inputCls}
          />
        </label>
      </div>
      <label className={labelCls}>
        {t('fieldDescription')}
        <input
          name="description"
          defaultValue={d?.description ?? ''}
          placeholder={t('fieldDescriptionPlaceholder')}
          className={inputCls}
        />
      </label>
      {/* The attachment is chosen on Add only — changing the file of an existing record is the separate,
          separately-audited Replace action (content-replaced event), not a metadata edit. */}
      {!d && (
        <>
          <label className={labelCls}>
            {t('fieldFile')} <span className="text-destructive">*</span>
            <input type="file" name="file" accept={ACCEPT} required className={fileCls} />
          </label>
          <p className="text-xs text-muted-foreground">{t('supportedTypes')}</p>
        </>
      )}
      <div className="flex justify-end">
        <button className={btnPrimary}>{d ? t('save') : t('upload')}</button>
      </div>
    </form>
  );

  const replaceDialogForm = (d: DocumentVM) => (
    <form action={replaceEmployeeDocumentAction} className="flex flex-col gap-3">
      <input type="hidden" name="employmentId" value={employmentId} />
      <input type="hidden" name="documentId" value={d.id} />
      <input type="hidden" name="tab" value="documents" data-tab-tracker="" />
      <label className={labelCls}>
        {t('replaceHint')}
        <input type="file" name="file" accept={ACCEPT} required className={fileCls} />
      </label>
      <p className="text-xs text-muted-foreground">{t('supportedTypes')}</p>
      <div className="flex justify-end">
        <button className={btnPrimary}>{t('actionReplace')}</button>
      </div>
    </form>
  );

  return (
    <section className="border-t border-border">
      {/* The category suggestions live OUTSIDE every dialog on purpose: a <datalist> only resolves while it
          is mounted, and the dialogs mount their bodies lazily — keeping it here is what stops the Category
          suggestions from disappearing whenever the Add dialog happens to be closed. */}
      <datalist id="employee-doc-categories">
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
        <FamilyFormDialog triggerLabel={t('addDocument')} title={t('addTitle')}>
          {documentDialogForm(null)}
        </FamilyFormDialog>
      </div>

      {/* Search + filters (unchanged behaviour — the reporter asked for these to stay). */}
      {docs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
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

      {docs.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">{t('empty')}</p>
      ) : filtered.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">{t('noMatches')}</p>
      ) : (
        <div className="overflow-x-auto px-4 pb-4">
          <table className="w-full min-w-[64rem] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">{t('colTitle')}</th>
                <th className="py-2 pr-3 font-medium">{t('colCategory')}</th>
                <th className="py-2 pr-3 font-medium">{t('colFile')}</th>
                <th className="py-2 pr-3 font-medium">{t('colType')}</th>
                <th className="py-2 pr-3 font-medium">{t('colSize')}</th>
                <th className="py-2 pr-3 font-medium">{t('colUploaded')}</th>
                <th className="py-2 pr-3 font-medium">{t('colUpdated')}</th>
                <th className="py-2 text-right font-medium">{t('colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.id} className="border-b border-border/60 align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-foreground">{d.title}</div>
                    {d.description && <div className="text-xs text-muted-foreground">{d.description}</div>}
                  </td>
                  <td className="py-2 pr-3 text-muted-foreground">{d.category || '—'}</td>
                  <td className="max-w-40 truncate py-2 pr-3 font-mono text-xs" title={d.fileName}>
                    {d.fileName}
                  </td>
                  <td className="py-2 pr-3">{d.typeLabel}</td>
                  <td className="py-2 pr-3 tabular-nums">{d.sizeLabel}</td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">
                    <div className="tabular-nums">{d.uploadedAt}</div>
                    <div>{d.uploadedBy || '—'}</div>
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">
                    <div className="tabular-nums">{d.updatedAt}</div>
                    <div>{d.updatedBy || '—'}</div>
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {/* View and Download stay LINKS to the streaming route (they are navigations, not
                          forms) — only their skin changes, so the download path is untouched. */}
                      {d.inlineViewable && (
                        <Button asChild variant="outline" size="sm">
                          <a
                            href={`/admin/personnel/${employmentId}/document/${d.id}?inline=1`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t('actionView')}
                          </a>
                        </Button>
                      )}
                      <Button asChild variant="outline" size="sm">
                        <a href={`/admin/personnel/${employmentId}/document/${d.id}`}>{t('actionDownload')}</a>
                      </Button>
                      <FamilyFormDialog
                        triggerLabel={t('actionEdit')}
                        triggerVariant="outline"
                        title={t('editTitle')}
                      >
                        {documentDialogForm(d)}
                      </FamilyFormDialog>
                      <FamilyFormDialog
                        triggerLabel={t('actionReplace')}
                        triggerVariant="outline"
                        title={t('replaceTitle')}
                      >
                        {replaceDialogForm(d)}
                      </FamilyFormDialog>
                      {/* Delete lives INSIDE the tab shell, so ConfirmSubmit's requestSubmit() fires a
                          bubbling submit the shell's capture listener sees (tab retention for free). The
                          admin gate is unchanged — it is enforced in deleteEmployeeDocumentAction. */}
                      <form action={deleteEmployeeDocumentAction}>
                        <input type="hidden" name="employmentId" value={employmentId} />
                        <input type="hidden" name="documentId" value={d.id} />
                        <input type="hidden" name="tab" value="documents" data-tab-tracker="" />
                        <ConfirmSubmit
                          size="sm"
                          variant="destructive"
                          title={t('actionDelete')}
                          description={t('confirmDelete')}
                          confirmLabel={t('actionDelete')}
                        >
                          {t('actionDelete')}
                        </ConfirmSubmit>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
