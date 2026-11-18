import type { Document } from './lifecycle-v9-model';
/** Presentation is frozen with the document; no current-company lookup belongs in either renderer. */
export function v9Letterhead(document: Pick<Document, 'mergeValues'>) {
  const values = document.mergeValues ?? {}, color = values['company.color'];
  return { name: values['company.name'] ?? values.company ?? '', registration: 'Registration No. ' + (values['company.regNo'] || '[REG. NO.]'), address: values['company.address'] || '[COMPANY ADDRESS]', color: /^#[0-9a-fA-F]{6}$/.test(color ?? '') ? color : '#4F46E5' };
}
