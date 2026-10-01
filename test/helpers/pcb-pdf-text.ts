import { PDFDocument, PDFName, PDFDict, PDFRawStream, decodePDFRawStream, PDFArray } from 'pdf-lib';

function bfMapOf(cmap: string): Map<number, string> {
  const utf16be = (hex: string) => {
    const b = Buffer.from(hex, 'hex');
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i));
    return s;
  };
  const map = new Map<number, string>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(m[1], 16), utf16be(m[2]));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      const dst = parseInt(m[3], 16);
      for (let c = lo; c <= hi; c += 1) map.set(c, String.fromCodePoint(dst + (c - lo)));
    }
  }
  return map;
}

type FontInfo = { composite: boolean; toUnicode: Map<number, string> | null; baseFont: string };

/** Every font resource this page can draw with, keyed by the `/Fx` name the content stream selects. */
function fontsOfPage(page: ReturnType<PDFDocument['getPages']>[number]): Map<string, FontInfo> {
  const out = new Map<string, FontInfo>();
  const dict = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
  if (!dict) return out;
  for (const [key, ref] of dict.entries()) {
    const fd = page.node.context.lookup(ref, PDFDict);
    const tu = fd.get(PDFName.of('ToUnicode'));
    const stream = tu ? page.node.context.lookup(tu) : null;
    out.set(key.asString(), {
      composite: fd.get(PDFName.of('Subtype'))?.toString() === '/Type0',
      baseFont: fd.get(PDFName.of('BaseFont'))?.toString() ?? '',
      toUnicode:
        stream instanceof PDFRawStream
          ? bfMapOf(Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'))
          : null,
    });
  }
  return out;
}

function contentOf(page: ReturnType<PDFDocument['getPages']>[number]): string {
  const contents = page.node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((r) => page.node.context.lookup(r))
      : [contents];
  let src = '';
  for (const st of streams) {
    if (st instanceof PDFRawStream) src += Buffer.from(decodePDFRawStream(st).decode()).toString('latin1');
  }
  return src;
}

/** One show-text operand: what was drawn, and AT WHAT SIZE — the size is how `fitSize` is checked. */
type DrawnRun = { text: string; size: number };

/** Every run the document draws, decoded through whichever font drew it. */
async function drawnRuns(bytes: Uint8Array): Promise<DrawnRun[]> {
  const doc = await PDFDocument.load(bytes);
  const out: DrawnRun[] = [];
  for (const page of doc.getPages()) {
    const fonts = fontsOfPage(page);
    let cur: FontInfo | null = null;
    let size = 0;
    for (const m of contentOf(page).matchAll(
      /(\/[A-Za-z0-9#+._-]+)\s+([\d.]+)\s+Tf|<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^\\()])*)\)\s*Tj/g,
    )) {
      if (m[1] != null) {
        cur = fonts.get(m[1]) ?? null;
        size = Number(m[2]);
      } else if (m[3] != null) {
        const hex = m[3].replace(/\s+/g, '');
        if (cur?.composite) {
          let s = '';
          for (let i = 0; i + 4 <= hex.length; i += 4) {
            s += cur.toUnicode?.get(parseInt(hex.slice(i, i + 4), 16)) ?? '\uFFFD';
          }
          out.push({ text: s, size });
        } else {
          out.push({ text: Buffer.from(hex, 'hex').toString('latin1'), size });
        }
      } else if (m[4] != null) {
        out.push({ text: m[4].replace(/\\([()\\])/g, '$1'), size });
      }
    }
  }
  return out;
}

/** The text the document actually DRAWS, decoded through whichever font drew each run. */
export async function extractedText(bytes: Uint8Array): Promise<string> {
  return (await drawnRuns(bytes)).map((r) => r.text).join('\n');
}

