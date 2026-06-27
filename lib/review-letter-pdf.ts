// Employment-review outcome letter (0110) — a SINGLE data-driven A4 template parameterised by
// `decision` + `reviewType`, rendered with pdf-lib (pure JS, no WASM/native, no Next bundler friction).
// A pure function over the review data + i18n-translated labels, so it is unit-testable and reused
// identically by the letter route. Mirrors lib/ea-pdf.ts.
//
// Font limitation (must-state, byte-output correctness): like lib/ea-pdf.ts this embeds Helvetica
// (WinAnsi/Latin-1) and degrades non-Latin names to '?' via the same documented safe() filter (tracked
// under ADR-0036). The letter is Latin-only in v1; embedding a Unicode font is the deferred ADR-0036
// follow-up. Do NOT silently emit tofu for zh/ta/th.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export type ReviewLetterData = {
  decision: 'confirm' | 'extend' | 'terminate';
  reviewType: 'probation' | 'contract' | 'internship';
  employer: string;
  employeeName: string;
  endDate: string;
  extendToDate: string | null;
  decidedOn: string; // YYYY-MM-DD (date of the HR decision)
};

export type ReviewLetterLabels = {
  title: string; // already selected for decision+reviewType by the caller
  dateLabel: string;
  reLabel: string; // "Re:"
  reText: string; // already interpolated with the review-type label
  greeting: string; // e.g. "Dear {name}" already interpolated
  body: string; // already interpolated with type/date/extend
  signOff: string; // "Yours sincerely,"
  hrSignature: string; // "Human Resources"
  disclaimer: string;
};

export async function renderReviewLetter(d: ReviewLetterData, t: ReviewLetterLabels): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(t.title);
  doc.setProducer('AI HR');
  const page = doc.addPage([595.28, 841.89]); // A4 portrait
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const M = 56;
  const right = page.getWidth() - M;
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.45, 0.45, 0.5);
  const accent = rgb(0.21, 0.24, 0.55);
  // Helvetica is WinAnsi (Latin-1). A non-Latin name degrades to '?' here — documented, tracked limitation
  // (ADR-0036), not an accidental silent drop.
  const safe = (s: string) => (s ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

  let y = page.getHeight() - M;
  const text = (s: string, x: number, size: number, f = font, color = ink) =>
    page.drawText(safe(s), { x, y, size, font: f, color });
  const textR = (s: string, xr: number, size: number, f = font, color = ink) => {
    const w = f.widthOfTextAtSize(safe(s), size);
    page.drawText(safe(s), { x: xr - w, y, size, font: f, color });
  };

  // Wrap a paragraph at `width` (rough word-wrap on the embedded font metrics).
  const paragraph = (s: string, size: number, lineGap = 4) => {
    const words = safe(s).split(/\s+/);
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(test, size) > right - M && line) {
        page.drawText(line, { x: M, y, size, font, color: ink });
        y -= size + lineGap;
        line = w;
      } else {
        line = test;
      }
    }
    if (line) {
      page.drawText(line, { x: M, y, size, font, color: ink });
      y -= size + lineGap;
    }
  };

  // Company header
  text(d.employer, M, 16, bold, accent);
  y -= 28;
  textR(`${t.dateLabel}: ${d.decidedOn}`, right, 10, font, muted);
  y -= 24;

  // Re: line
  text(t.reLabel, M, 10.5, bold);
  text(t.reText, M + 28, 10.5, bold);
  y -= 26;

  // Greeting
  text(t.greeting, M, 11);
  y -= 22;

  // Body
  paragraph(t.body, 11, 6);
  y -= 16;

  // Sign-off
  text(t.signOff, M, 11);
  y -= 34;
  text(t.hrSignature, M, 11, bold);
  y -= 26;

  // Disclaimer footer
  page.drawText(safe(t.disclaimer), { x: M, y: M, size: 8, font, color: muted });

  return doc.save();
}
