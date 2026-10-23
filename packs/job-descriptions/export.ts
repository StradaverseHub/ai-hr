import type { readJobDocument } from './owner';
/** Readable export, no executable fields, includes the complete stored form snapshot and review trail. */
export function exportJobText(detail: Awaited<ReturnType<typeof readJobDocument>>): string {
    const { job, revision: r } = detail;
    const lines = [r.title, `Common Job ID: ${job.job_code}`, `Company: ${r.org_labels.company ?? job.company_name}`, `Version: ${r.version} | Status: ${job.inactive ? 'inactive' : r.status}`, `Form version: ${r.definition.version}`, `Document owner: ${r.document_owner}`, `Prepared by: ${r.prepared_by} | ${r.created_at}`, `Effective: ${r.effective_on ?? ''} | Next review: ${r.review_on ?? ''}`, `Revision reason: ${r.reason}`, `Approved by: ${r.approved_by ?? ''} | ${r.approved_at ?? ''}`, ...Object.entries(r.org_labels).map(([key, v]) => `${key}: ${v}`)];
    for (const section of r.definition.sections) {
        lines.push('', `${section.form.toUpperCase()} — ${section.label}`);
        for (const [rowIndex, row] of (r.answers[section.id] ?? []).entries()) {
            if (section.repeated)
                lines.push(`Entry ${rowIndex + 1}`);
            for (const f of section.fields)
                lines.push(`${f.label}: ${row[f.id] ?? '—'}`);
        }
    }
    lines.push('', 'REVIEW DECISIONS', ...detail.reviews.map(v => `${v.name} (${v.reviewer_id}): ${v.decision} | ${v.decided_at ?? ''}\n${v.comments}`), '', 'SUPPORTING DOCUMENTS', ...detail.attachments.map(a => `${a.filename} | ${a.mime_type} | ${a.size} bytes`), '', 'REVISION HISTORY', ...detail.history.map(h => `v${h.version}: ${h.status} | Effective ${h.effective_on ?? ''} | Review ${h.review_on ?? ''} | ${h.reason}`), '', 'Names entered in document fields are recorded text, not verified signatures. Approval decisions record authenticated actors.');
    return lines.join('\n');
}
