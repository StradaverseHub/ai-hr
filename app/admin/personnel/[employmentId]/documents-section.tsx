// f018ce8d — Documents tab (Personnel/Admin). The tab used to show a read-only statutory summary; it is
// now a real employee document repository. This SERVER component RLS-loads the document metadata, formats
// the audit columns (dates/sizes/type labels) once, and hands the view-model to the client DocumentsManager
// which owns the Add form, the grid, per-row actions, and client-side search/filter. Statutory identifiers
// are unchanged — they remain the editable source of truth on the Bank & Statutory tab.
import { getTranslations } from 'next-intl/server';
import { Card, SectionHeader } from '@/components/ui';
import { listEmployeeDocuments } from '@/core/employee-documents';
import type { SessionContext } from '@/db/client';
import { DocumentsManager, type DocumentVM } from './documents-manager';

const TYPE_LABEL: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/msword': 'DOC',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.ms-excel': 'XLS',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.ms-powerpoint': 'PPT',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'text/plain': 'TXT',
};
const INLINE_VIEWABLE = new Set(['application/pdf', 'image/jpeg', 'image/png']);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateTime(d: Date): string {
  // Deterministic UTC ISO minute (avoids server/client TZ hydration drift): "2026-07-10 09:32".
  return new Date(d).toISOString().slice(0, 16).replace('T', ' ');
}

export async function DocumentsSection({ s, employmentId }: { s: SessionContext; employmentId: string }) {
  const t = await getTranslations('people.detail.documents');
  const rows = await listEmployeeDocuments(s, employmentId);
  const docs: DocumentVM[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    description: r.description,
    fileName: r.fileName,
    mimeType: r.mimeType,
    typeLabel: TYPE_LABEL[r.mimeType] ?? r.mimeType,
    sizeLabel: formatSize(r.sizeBytes),
    uploadedBy: r.uploadedBy,
    uploadedAt: formatDateTime(r.uploadedAt),
    updatedBy: r.updatedBy,
    updatedAt: formatDateTime(r.updatedAt),
    inlineViewable: INLINE_VIEWABLE.has(r.mimeType),
  }));
  const categories = [...new Set(docs.map((d) => d.category).filter((c): c is string => !!c))].sort();
  const types = [...new Set(docs.map((d) => d.typeLabel))].sort();

  return (
    // 0386b95d — `overflow-hidden` matches section-qualification, so the table clips to the card's rounded
    // corners the way every other list on the profile does.
    <Card id="section-documents" className="overflow-hidden">
      <SectionHeader title={t('title')} count={docs.length} />
      <p className="mx-4 mt-3 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{t('intro')}</p>
      <DocumentsManager
        employmentId={employmentId}
        docs={docs}
        categories={categories}
        types={types}
      />
    </Card>
  );
}
