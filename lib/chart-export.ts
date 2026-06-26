/**
 * Client-side chart-image export (Reporting & Analytics). Serialises a rendered chart's SVG node to a
 * Blob, rasterises it through a <canvas>, and downloads PNG / JPEG; PDF embeds the PNG via pdf-lib.
 *
 * The two correctness footguns a naive `outerHTML → img` export hits (both pass a "non-empty file"
 * check yet produce a wrong image), handled here:
 *  (a) Inline computed styles before serialise. The chart SVG themes its text/axes via CSS custom
 *      properties (var(--muted-foreground) etc.) carried by external stylesheets; a detached clone loses
 *      them and rasterises black/default. We walk the subtree and inline getComputedStyle fill/stroke/
 *      font onto each node so the PNG shows the real themed colours.
 *  (b) Fonts. Web-font glyphs won't embed in the rasterised image; the charts already use a system-font
 *      stack, and we re-assert it on every node so exports aren't garbled.
 *
 * Browser-only (uses document/canvas/Image) — imported lazily by the client ChartCard.
 */

const STYLE_PROPS = ['fill', 'stroke', 'stroke-width', 'font-family', 'font-size', 'font-weight', 'opacity', 'color'];
const SYSTEM_FONT = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';

/** Clone the SVG and inline computed styles so the detached node renders identically (a) + (b). */
function inlineStyledClone(svg: SVGSVGElement): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const srcNodes = [svg, ...Array.from(svg.querySelectorAll('*'))];
  const dstNodes = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (let i = 0; i < srcNodes.length; i++) {
    const cs = window.getComputedStyle(srcNodes[i]);
    const dst = dstNodes[i] as SVGElement;
    let style = '';
    for (const p of STYLE_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v && v !== 'none' && v !== 'normal') style += `${p}:${p === 'font-family' ? SYSTEM_FONT : v};`;
    }
    if (style) dst.setAttribute('style', style);
  }
  // Ensure explicit pixel dimensions for the raster (viewBox alone leaves intrinsic size ambiguous).
  const vb = svg.viewBox.baseVal;
  const w = vb && vb.width ? vb.width : svg.clientWidth || 640;
  const h = vb && vb.height ? vb.height : svg.clientHeight || 220;
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return clone;
}

/** Rasterise the styled SVG clone onto a 2× canvas with an opaque background (so JPEG/PDF aren't black). */
async function svgToCanvas(svg: SVGSVGElement, background: string): Promise<HTMLCanvasElement> {
  const clone = inlineStyledClone(svg);
  const vb = svg.viewBox.baseVal;
  const w = vb && vb.width ? vb.width : svg.clientWidth || 640;
  const h = vb && vb.height ? vb.height : svg.clientHeight || 220;
  const xml = new XMLSerializer().serializeToString(clone);
  const svg64 = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);

  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('chart raster failed'));
    img.src = svg64;
  });

  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function resolvedBackground(): string {
  // Use the live --card token so the export background matches the on-screen card (light/dark aware).
  const v = getComputedStyle(document.documentElement).getPropertyValue('--card').trim();
  return v || '#ffffff';
}

export type ChartImageFormat = 'png' | 'jpeg' | 'pdf';

/** Export a chart SVG (by element id) to the requested image format and trigger a download. */
export async function exportChart(svgId: string, format: ChartImageFormat, filenameBase: string): Promise<void> {
  const svg = document.getElementById(svgId) as SVGSVGElement | null;
  if (!svg) throw new Error(`chart svg #${svgId} not found`);
  const bg = resolvedBackground();
  const canvas = await svgToCanvas(svg, bg);

  if (format === 'png' || format === 'jpeg') {
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const blob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), mime, 0.95),
    );
    download(blob, `${filenameBase}.${format === 'png' ? 'png' : 'jpg'}`);
    return;
  }

  // PDF: embed the PNG raster via pdf-lib (lazy import — keeps it out of the initial client bundle).
  const pngBlob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  );
  const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(pngBytes);
  const margin = 24;
  const page = doc.addPage([png.width + margin * 2, png.height + margin * 2]);
  page.drawImage(png, { x: margin, y: margin, width: png.width, height: png.height });
  const bytes = await doc.save();
  download(new Blob([bytes as BlobPart], { type: 'application/pdf' }), `${filenameBase}.pdf`);
}
