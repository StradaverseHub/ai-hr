/**
 * Protected documents (payslip and EA PDFs, D7) exist on the device only as a random-named file in a
 * dedicated cache folder, for the lifetime of one explicit, confirmed use. Never in documents, never under
 * a readable name, never in the journey cache (journey-drafts.tsx owns that one).
 *
 * The folder is swept whole on launch, on going to the background, on logout and on an employment switch
 * (session.tsx). A sweep cannot fail a caller: an undeletable file is retried at the next sweep.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';

const FOLDER = 'aihr-protected';
const EXTENSIONS = { 'application/pdf': 'pdf' } as const;
export type ProtectedDocumentType = keyof typeof EXTENSIONS;
export type ProtectedDocument = { uri: string; mimeType: ProtectedDocumentType; size: number; delete(): void };

/** Write bytes under a fresh random name. A failed write leaves no partial file behind. */
export function writeProtectedDocument(bytes: Uint8Array, mimeType: ProtectedDocumentType): ProtectedDocument {
  const extension = EXTENSIONS[mimeType];
  if (!extension) throw new Error('Unsupported document type');
  const directory = new Directory(Paths.cache, FOLDER);
  if (!directory.exists) directory.create({ intermediates: true });
  const file = new File(directory, `${randomUUID()}.${extension}`);
  try { file.write(bytes); }
  catch (error) { try { if (file.exists) file.delete(); } catch { /* swept later */ } throw error; }
  let deleted = false;
  return {
    uri: file.uri, mimeType, size: bytes.byteLength,
    delete() { if (deleted) return; deleted = true; try { if (file.exists) file.delete(); } catch { /* swept later */ } },
  };
}

/** Delete every leftover protected document. Synchronous, idempotent, never throws. */
export function sweepProtectedDocuments(): void {
  try { const directory = new Directory(Paths.cache, FOLDER); if (directory.exists) directory.delete(); }
  catch { /* retried at the next launch, background, logout or switch */ }
}
