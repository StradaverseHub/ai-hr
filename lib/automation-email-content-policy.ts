import type {AutomationEmailContent} from './automation-email-ipc';
import {MANAGED_EMAIL_ATTACHMENT_MAX_BYTES,MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT} from './managed-email-policy';

/** Metadata only; file bytes are read by the private sender under its one-attempt capability. */
export function validateAutomationEmailContent(content: AutomationEmailContent): void {
  const fail = (): never => { throw new Error('The workflow email attachments are incomplete or no longer released.'); };
  if (!content || typeof content !== 'object' || typeof content.number !== 'string' || !content.number.trim() || content.number.length > 160) fail();
  if (!Array.isArray(content.documents) || !Array.isArray(content.pdfDocumentIds) || !Array.isArray(content.linkDocumentIds)) fail();
  const documents = new Map(content.documents.map(document => [document.id,document]));
  if (documents.size !== content.documents.length || content.documents.length > MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT) fail();
  if(content.documents.some(document=>!document.id||document.status!=='signed'))fail();
  for (const id of [...content.pdfDocumentIds,...content.linkDocumentIds]) {
    const document = documents.get(id);
    if (!document || document.status !== 'signed') fail();
  }
  const assets = content.assets ?? [], files = content.files ?? [];
  if (!Array.isArray(assets) || !Array.isArray(files)) fail();
  if (content.pdfDocumentIds.length + assets.length + files.length > MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT) fail();
  if (new Set(content.pdfDocumentIds).size !== content.pdfDocumentIds.length || new Set(content.linkDocumentIds).size !== content.linkDocumentIds.length) fail();
  if (new Set(assets.map(asset=>asset.id)).size !== assets.length || new Set(files.map(file=>file.id)).size !== files.length) fail();
  if (assets.length && (!content.emailTemplateId || content.emailTemplateId.length > 200)) fail();
  for (const asset of assets) {
    if (!asset.id || !['file','image'].includes(asset.kind) || !Number.isSafeInteger(asset.size) || asset.size < 1 || !/^[a-f0-9]{64}$/.test(asset.contentHash) || asset.kind === 'image' && !asset.alt?.trim()) fail();
  }
  if (assets.reduce((total,asset)=>total+asset.size,0) > MANAGED_EMAIL_ATTACHMENT_MAX_BYTES) fail();
  for (const file of files) if (!file.id || !file.storageId || !file.name || !/^[a-f0-9]{64}$/.test(file.contentHash)) fail();
  if (content.html !== undefined && (typeof content.html !== 'string' || new TextEncoder().encode(content.html).length > 256_000)) fail();
  if (new TextEncoder().encode(JSON.stringify(content)).length > 1_000_000) fail();
}
