/** Browser-only document reading; raw source never reaches a server action. */
export async function readDescription(file: File): Promise<string> {
  if (file.size > 5 * 1024 * 1024) throw new Error('file');
  const suffix = file.name.toLowerCase().split('.').pop();
  let text: string;
  if (suffix === 'txt' || suffix === 'md') text = await file.text();
  else if (suffix === 'docx') {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entry = zip.file('word/document.xml');
    if (!entry) throw new Error('file');
    const xml = await new Promise<string>((resolve, reject) => {
      let length = 0; const chunks: string[] = [];
      // JSZip documents this API but omits it from JSZipObject's declarations.
      const stream = (entry as typeof entry & { internalStream(type: 'string'): import('jszip').JSZipStreamHelper<string> }).internalStream('string');
      stream.on('data', chunk => { length += chunk.length; if (length > 2_000_000) { stream.pause(); reject(new Error('file')); } else chunks.push(chunk); });
      stream.on('error', reject); stream.on('end', () => resolve(chunks.join(''))); stream.resume();
    });
    const document = new DOMParser().parseFromString(xml, 'application/xml');
    if (document.querySelector('parsererror')) throw new Error('file');
    text = Array.from(document.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'p')).map(p => p.textContent).join('\n');
  } else if (suffix === 'pdf') {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    // PDF.js 6 removed its eval-based PostScript compiler and the isEvalSupported option.
    // Use the text API only; do not instantiate the scripting-enabled viewer.
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), disableFontFace: true });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 10) throw new Error('file');
      const pages: string[] = [];
      for (let page = 1; page <= pdf.numPages; page++) {
        const content = await (await pdf.getPage(page)).getTextContent();
        pages.push(content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join(''));
      }
      text = pages.join('\n');
    } finally { await task.destroy(); }
  } else throw new Error('file');
  if (text.trim().length < 30 || text.length > 30000) throw new Error('file');
  return text;
}

