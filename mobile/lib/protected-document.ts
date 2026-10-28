/**
 * Protected documents (payslip and EA PDFs, D7) exist on the device only as a random-named file in a
 * dedicated cache folder, for the lifetime of one explicit, confirmed use. Never in documents, never under
 * a readable name, never in the journey cache (journey-drafts.tsx owns that one).
 *
 * The folder is swept whole on launch, on going to the background, on logout and on an employment switch
 * (session.tsx). A sweep cannot fail a caller: an undeletable file is retried at the next sweep.
 *
 * M09 — ONE EXEMPTION, FROM ONE SWEEP. Android opens the OS share sheet as another activity, so the app goes to the
 * background while the person is still choosing where the file goes; the background sweep would delete the very
 * file being shared. A document handed to `shareProtectedDocument` is therefore skipped by the BACKGROUND sweep
 * (`keepSharing`) until its share promise settles, and is deleted the moment it does, whichever way it settles. The
 * launch, logout and employment-switch sweeps still take it.
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

/** File names (the random part) of documents in an OS share right now. In memory only: a killed process shares nothing. */
const sharing = new Set<string>();
const nameOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

/**
 * Hand one document to `share` (the OS share sheet), exempt from the background sweep until the promise settles,
 * then delete it — on success, on cancel and on failure alike. Returns what `share` returned.
 */
export async function shareProtectedDocument<T>(document: ProtectedDocument, share: (uri: string) => Promise<T>): Promise<T> {
  const name = nameOf(document.uri);
  sharing.add(name);
  try { return await share(document.uri); }
  finally { sharing.delete(name); document.delete(); }
}

/**
 * Delete every leftover protected document. Synchronous, idempotent, never throws. `keepSharing` (the background
 * sweep only) spares the documents in an OS share right now and deletes everything else.
 */
export function sweepProtectedDocuments(options: { keepSharing?: boolean } = {}): void {
  try {
    const directory = new Directory(Paths.cache, FOLDER);
    if (!directory.exists) return;
    if (!options.keepSharing || sharing.size === 0) { directory.delete(); return; }
    for (const entry of directory.list()) {
      if (sharing.has(entry.name || nameOf(entry.uri))) continue;
      try { entry.delete(); } catch { /* retried at the next sweep */ }
    }
  }
  catch { /* retried at the next launch, background, logout or switch */ }
}
