/** Read the name from the attachment response, preferring its UTF-8 filename. */
export function exportFilename(disposition: string | null): string | null {
  if (!disposition || !/^attachment(?:\s*;|\s*$)/i.test(disposition)) return null;
  const encoded = /(?:^|;)\s*filename\*=UTF-8'[^']*'([^;]+)/i.exec(disposition)?.[1];
  if (encoded) {
    try {
      const name = decodeURIComponent(encoded.trim()).split(/[/\\]/).pop();
      if (name) return name;
    } catch {
      // Older or malformed responses may still supply the ASCII fallback.
    }
  }
  const fallback = /(?:^|;)\s*filename=(?:"([^"]+)"|([^;]+))/i.exec(disposition);
  return (fallback?.[1] ?? fallback?.[2])?.trim().split(/[/\\]/).pop() || 'export';
}
