/**
 * 5b2a7f0f — THE UNICODE HALF OF ADR-0036, which that ADR deferred and this closes.
 *
 * The payslip document printed Tamil, Thai, Chinese and Vietnamese as question marks: `renderPayslipPdf`
 * draws with the built-in Helvetica, which is WinAnsi (Latin-1), and the last step of its `safe()` folded
 * every codepoint outside Latin-1 to '?'. Measured on main@fbe66e35, over the 68 label strings the two PDF
 * routes resolve through `payslipPdfStrings`: **zh 63, ta 63, th 63, vi 53 unprintable; en 0, ms 0**.
 * (The brief for this round said "ms 10, en 0". That is the count BEFORE `safe()`'s punctuation fold, and
 * it is 7 in both locales, not 10 in one and 0 in the other — en and ms carry the same seven em dashes and
 * the fold handles all of them. The load-bearing half of the claim holds: en and ms print correctly today.)
 *
 * WHAT THIS MODULE IS. The one place that knows which font file covers which script, and the only place
 * that reads a font off disk. It hands `lib/payslip-pdf.ts` a list of already-embedded faces; that file
 * decides, per drawn string, which face to draw it in.
 *
 * ─────────────────────────────── the four decisions, and why ───────────────────────────────
 *
 * 1. ONE FACE PER SCRIPT, AND EACH ONE ALSO COVERS LATIN. No single Noto face covers Latin + Tamil + Thai
 *    + CJK. pdf-lib draws one run with one font, and a Chinese payslip for an employee whose name is
 *    romanized is the NORMAL case, not the edge case — so the choice was "a face that covers both, or
 *    split the run". THIS TAKES THE FACE. Splitting a run would mean splitting every measurement too
 *    (`wrap` measures against the real font, and the whole no-clipping property of this document rests on
 *    that), for a gain of nothing: the `full/` Noto builds below carry complete ASCII + Latin-1 alongside
 *    their script, verified by `characterSet` rather than assumed. Mixed Latin+CJK and mixed Latin+Tamil
 *    therefore draw as ONE run in ONE font with no '?' on either side (test/payslip-pdf-unicode.test.ts).
 *
 *    The residue: a SINGLE STRING mixing two non-Latin scripts (a Tamil name inside a Chinese label) still
 *    cannot be one run. It degrades — the face covering most of the string wins and the rest clamps to '?'
 *    — and it never throws. No such string exists on this document today.
 *
 * 2. LOADED LAZILY, PER LOCALE. `payslipFaceScripts` looks at the strings this document will actually
 *    draw. An en or ms payslip needs no face, so it reads NO font file, registers no fontkit, embeds
 *    nothing, and comes out byte-for-byte the document it was before this change. The 5.8 MB CJK file is
 *    never touched unless a Chinese string is on the page.
 *
 * 3. SUBSET PER DOCUMENT. `embedFont(bytes, { subset: true })` — the PDF carries only the glyphs it draws,
 *    which is what keeps a Chinese payslip ~35 KB larger rather than ~8 MB larger.
 *
 * 4. BOLD: REAL FOR LATIN/TAMIL/THAI, FOLDED TO REGULAR FOR CJK. A Bold file is a second whole font.
 *    ~52 KB (brotli) buys Tamil's; a CJK Bold would cost another 5.8 MB, which is not a reasonable price
 *    for the weight of four headings. So `cjk.bold === cjk.regular` and a Chinese heading prints at
 *    regular weight. Every FIGURE on the document stays Helvetica-Bold exactly as today — amounts are
 *    ASCII, so they never reach a face at all.
 *
 * ─────────────────────────────── the files, and where they came from ───────────────────────────────
 *
 * Stored brotli-compressed (`.br`) and inflated once per process with Node's built-in `zlib`. Compressing
 * costs no dependency and is what keeps the largest committed artefact at 5.81 MiB instead of 7.95 MiB;
 * inflating the CJK face measures 61 ms, paid once for the life of the process, never per payslip.
 *
 *   file (committed)                    committed    inflated   sha256 of the INFLATED font
 *   NotoSans-Regular.ttf.br               244,123     621,572   478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823
 *   NotoSans-Bold.ttf.br                  250,438     631,484   1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913
 *   NotoSansTamil-Regular.ttf.br           51,912     115,856   0afbc221964b6048c6d771c525be474d21b288a621dce0fafedd695cc5c98e4e
 *   NotoSansTamil-Bold.ttf.br              52,054     118,668   39bbf8317e5c899ae381d467e651ea49a1e3d5189d16075f24c3c593a365ac7a
 *   NotoSansThai-Regular.ttf.br            35,335      72,812   2101faa471942570d506a394df7da555d15246c7814c7522c63d4fa85b0d8d88
 *   NotoSansThai-Bold.ttf.br               35,212      72,840   dd99014fba00806b1d8da54afa978b37149b950b56c6b44b5e0b5c5dcd78f245
 *   NotoSansSC-Regular.otf.br           6,090,080   8,331,336   faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9
 *                                       ─────────   ─────────
 *                                        6,759,154   9,964,568
 *
 * Sources, unaltered:
 *   NotoSans-{Regular,Bold}       github.com/notofonts/notofonts.github.io  fonts/NotoSans/hinted/ttf/
 *   NotoSansTamil-{Regular,Bold}  github.com/notofonts/notofonts.github.io  fonts/NotoSansTamil/full/ttf/
 *   NotoSansThai-{Regular,Bold}   github.com/notofonts/notofonts.github.io  fonts/NotoSansThai/full/ttf/
 *   NotoSansSC-Regular.otf        github.com/notofonts/noto-cjk            Sans/SubsetOTF/SC/
 *
 * The `full/` build of Tamil and Thai is deliberate and NOT the default one. `hinted/ttf/` ships a slim
 * face — 74 KB Tamil, 38 KB Thai — that has NO ASCII in its cmap, so decision 1 above would be impossible
 * with it: "நிகர ஊதியம் EMP-001" would lose "EMP-001". Measured, not assumed: slim Tamil cmap = 147
 * codepoints and misses 6 of 18 sampled ASCII; `full/` = 428 and misses none.
 *
 * THE CJK FACE IS THE SMALLEST COMPLETE ONE PUBLISHED. The alternatives were measured and rejected:
 * Noto Sans CJK SC full OTF is 16,437,364 bytes and the Google Fonts variable TTF is 17,772,300 — the
 * "tens of megabytes" case. `Sans/SubsetOTF/SC` is the region-specific build: 30,890 codepoints, complete
 * for simplified AND traditional Han (verified against 實 發 工 資 齒 點 龘 and 〇), at 8,331,336 bytes
 * inflated / 6,090,080 committed. There is no smaller complete Chinese face in the Noto family.
 *
 * ─────────────────────── THE SUBSETTER, AND THE ONE THAT DOES NOT WORK ───────────────────────
 *
 * pdf-lib 1.17.1 does not subset fonts itself: it drives whatever `registerFontkit` is given. The obvious
 * candidate, `@pdf-lib/fontkit@1.1.1`, is what pdf-lib's own README names — AND IT PRODUCES CORRUPT
 * SUBSETS FOR THIS FONT. Measured, not inferred, on 2026-09-24:
 *
 *   • CFF/OTF path — `NotoSansSC-Regular.otf` subsetted through it rendered as a row of unrelated ASCII
 *     letters in CoreGraphics (Quick Look, Preview). The SAME font embedded with `subset: false`
 *     rendered the Chinese perfectly, which is what isolates the subsetter rather than the font.
 *   • glyf/TTF path — a TrueType Chinese face subsetted through it rendered two or three glyphs out of
 *     twenty. The embedded font stream it wrote cannot be parsed by fontTools at all
 *     (`struct.error: unpack requires a buffer of 61 bytes` inside `glyf`). Reducing the source face to
 *     500 glyphs did not help, so it is not a size limit.
 *   • Tamil — it throws outright: `ReferenceError: regeneratorRuntime is not defined`, from the Indic
 *     shaper's state machine, because the fork is a 2019 Babel bundle missing its own runtime.
 *
 * Upstream `fontkit@1.9.0` — the package that fork was taken from — does all three correctly and exposes
 * the same `create` / `layout` / `createSubset` / `includeGlyph` / `encodeStream` surface pdf-lib calls,
 * so it drops straight in. It costs 14 packages in the lockfile against the fork's 2. That is the trade
 * this file takes: a broken payslip is not cheaper than fourteen packages.
 *
 * ⚠️ THE TEXT LAYER IS NOT THE RENDER. `/ToUnicode` extraction came back with perfect Chinese from the
 * corrupt document — the CMap was right and the glyph outlines were not. Only rasterising the page found
 * it. Any future change to the embedding path must be checked by LOOKING at the page, not by reading its
 * text back (CLAUDE.md §8: when two PDF renderers disagree, the disagreement is the instrument).
 *
 * WHY NOT `public/`. `public/` is served statically by Next, which would put 6 MB of font on a public URL
 * for no reader's benefit. These are read off disk server-side at render time and never reach a bundle.
 * `process.cwd()` is the right base for that read: the deploy rsyncs this repo to /opt/ai-hr and runs the
 * server from it, which is the same arrangement `lib/cp22-template.ts` already relies on.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

import type { PDFDocument, PDFFont } from 'pdf-lib';

/** The scripts that need a face of their own. Anything outside Latin-1 that is not Tamil, Thai or CJK —
 *  Vietnamese, Latin Extended, Greek, Cyrillic — is `latin`: Noto Sans covers it. */
export type PayslipFaceScript = 'latin' | 'tamil' | 'thai' | 'cjk';

type FaceFile = { regular: string; bold: string };

const FILES: Record<PayslipFaceScript, FaceFile> = {
  latin: { regular: 'NotoSans-Regular.ttf.br', bold: 'NotoSans-Bold.ttf.br' },
  tamil: { regular: 'NotoSansTamil-Regular.ttf.br', bold: 'NotoSansTamil-Bold.ttf.br' },
  thai: { regular: 'NotoSansThai-Regular.ttf.br', bold: 'NotoSansThai-Bold.ttf.br' },
  // Decision 4: no CJK Bold file. Bold CJK text draws in the Regular face.
  cjk: { regular: 'NotoSansSC-Regular.otf.br', bold: 'NotoSansSC-Regular.otf.br' },
};

export const PAYSLIP_FONT_DIR = join('assets', 'fonts');

/**
 * Which script a codepoint belongs to, for codepoints OUTSIDE Latin-1 only.
 *
 * Ranges, not a library: the four answers this document can need are three contiguous blocks and a
 * catch-all, and a Unicode property table would be a dependency and a data file to keep in step for
 * nothing. CJK is deliberately wide — Han, the CJK punctuation block, kana and the fullwidth forms — so
 * that a Chinese string carrying a fullwidth comma or an ideographic space resolves to the CJK face
 * rather than splitting the string's answer across two of them.
 */
function scriptOfCodePoint(cp: number): PayslipFaceScript {
  if (cp >= 0x0b80 && cp <= 0x0bff) return 'tamil';
  if (cp >= 0x0e00 && cp <= 0x0e7f) return 'thai';
  if (
    (cp >= 0x2e80 && cp <= 0x9fff) || // CJK radicals, Kangxi, punctuation, kana, Han
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xffef) || // halfwidth and fullwidth forms
    (cp >= 0x20000 && cp <= 0x3ffff) // Han extensions B…
  ) {
    return 'cjk';
  }
  return 'latin';
}

/** True for a codepoint the built-in Helvetica can already draw. `safe()`'s own clamp is the same test. */
export const isWinAnsiCodePoint = (cp: number) => (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff);

/**
 * Which faces the strings on this document need, in the order they should be preferred.
 *
 * Returns `[]` for a document whose every string is Latin-1 — which is the whole en/ms path, and the
 * reason those documents are unchanged. The strings passed in are the FOLDED ones: `safe()`'s
 * smart-quote/dash/ellipsis normalisation runs first, so punctuation that has a Latin-1 equivalent never
 * drags a whole font file in.
 */
export function payslipFaceScripts(foldedStrings: Iterable<string>): PayslipFaceScript[] {
  const counts = new Map<PayslipFaceScript, number>();
  for (const s of foldedStrings) {
    for (const ch of s ?? '') {
      const cp = ch.codePointAt(0);
      if (cp == null || isWinAnsiCodePoint(cp)) continue;
      const script = scriptOfCodePoint(cp);
      counts.set(script, (counts.get(script) ?? 0) + 1);
    }
  }
  // Most-used script first, so `bestFaceFor` has a stable tie-break that favours the document's own
  // language over an incidental character in a name.
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([script]) => script);
}

/** One face, embedded in one document, with the coverage needed to clamp what it cannot draw. */
export type PayslipFace = {
  script: PayslipFaceScript;
  regular: PDFFont;
  bold: PDFFont;
  /** Every codepoint the face can draw. Read from the embedded font, never assumed from the file name. */
  chars: Set<number>;
};

/** Inflated font bytes, cached for the life of the process — a build artefact, not tenant data. */
const bytesCache = new Map<string, Uint8Array | null>();

function faceBytes(file: string): Uint8Array | null {
  const hit = bytesCache.get(file);
  if (hit !== undefined) return hit;
  let out: Uint8Array | null = null;
  try {
    // A BUFFER, NOT A BARE Uint8Array. fontkit sniffs the sfnt tag with `buffer.toString('ascii', 0, 4)`,
    // which only Buffer implements; handed a plain Uint8Array it answers `Error: Unknown font format` and
    // the face is silently dropped. `brotliDecompressSync` already returns a Buffer — leave it one.
    out = brotliDecompressSync(readFileSync(join(process.cwd(), PAYSLIP_FONT_DIR, file)));
  } catch (err) {
    // A MISSING OR CORRUPT FONT FILE MAY NOT BREAK A PAYSLIP. The document's own header records that
    // nothing on it clips or crashes; a botched deploy that loses an asset must degrade to the question
    // marks this change removes, not to a 500 on the one document an employee is entitled to.
    //
    // BUT IT MUST NOT BE SILENT. Swallowing this is how "the Chinese payslip is full of '?' again" becomes
    // a defect nobody can explain; the line below is the only trace a server will have. Warned once per
    // file per process — the cache below records the null, so this cannot become a log flood.
    console.warn(`[payslip-pdf-fonts] could not read ${file}; text in that script will print as '?'`, err);
    out = null;
  }
  bytesCache.set(file, out);
  return out;
}

/**
 * Embed the faces this document needs, subsetted, and nothing else.
 *
 * Nothing is read, imported or registered when `scripts` is empty: that is the en/ms path and it must stay
 * byte-identical. fontkit is a DYNAMIC import for the same reason — an English payslip should not pay 1.5
 * MB of parser load for a font it will not use.
 */
export async function embedPayslipFaces(
  doc: PDFDocument,
  scripts: readonly PayslipFaceScript[],
): Promise<PayslipFace[]> {
  if (scripts.length === 0) return [];
  const wanted = scripts.map((script) => ({ script, bytes: faceBytes(FILES[script].regular) })).filter((s) => s.bytes);
  if (wanted.length === 0) return [];

  const mod = (await import('fontkit')) as unknown as { default?: unknown };
  const fontkit = (mod.default ?? mod) as Parameters<PDFDocument['registerFontkit']>[0];
  doc.registerFontkit({
    ...fontkit,
    create(...args: Parameters<typeof fontkit.create>) {
      const face = fontkit.create(...args);
      // Fontkit caches composite components before their later text runs can supply Unicode.
      // Prime the Latin faces first so Vietnamese letters retain their PDF text mappings.
      // Preserve the other scripts' shaping and the English/Malay built-in-font path.
      if (/^NotoSans-(Regular|Bold)$/.test(face.postscriptName ?? '')) {
        for (const cp of face.characterSet) {
          // Prime base/extended Latin and combining marks, retaining ligatures' actual letter sequences.
          // Priming Unicode presentation ligatures would replace "officer" with "oﬃcer" in copied text.
          if ((cp >= 0x20 && cp <= 0x024f) || (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1e00 && cp <= 0x1eff)) {
            face.glyphForCodePoint(cp);
          }
        }
      }
      return face;
    },
  });

  const out: PayslipFace[] = [];
  for (const { script, bytes } of wanted) {
    try {
      const regular = await doc.embedFont(bytes!, { subset: true });
      const boldFile = FILES[script].bold;
      const bold =
        boldFile === FILES[script].regular
          ? regular
          : await (async () => {
              const b = faceBytes(boldFile);
              return b ? doc.embedFont(b, { subset: true }) : regular;
            })();
      out.push({ script, regular, bold, chars: new Set(regular.getCharacterSet()) });
    } catch (err) {
      // A face that will not parse is a face this document does without — see `faceBytes`. Warned for the
      // same reason: a payslip quietly losing a script is worse than a noisy server log.
      console.warn(`[payslip-pdf-fonts] could not embed the ${script} face; that script will print as '?'`, err);
    }
  }
  return out;
}

/**
 * The face to draw `folded` in, or null when Helvetica already covers it.
 *
 * "Most of the string" rather than "the first non-Latin-1 character": a Chinese label carrying one stray
 * Tamil letter should still be a Chinese label. Latin-1 characters are not counted at all — every face
 * here covers them — so a mixed "实发工资 Aisyah Rahman" scores exactly as its Han does and resolves to
 * the one face that can draw the whole run.
 */
export function bestFaceFor(folded: string, faces: readonly PayslipFace[]): PayslipFace | null {
  if (faces.length === 0) return null;
  let best: PayslipFace | null = null;
  let bestScore = 0;
  for (const face of faces) {
    let score = 0;
    for (const ch of folded) {
      const cp = ch.codePointAt(0);
      if (cp == null || isWinAnsiCodePoint(cp)) continue;
      if (face.chars.has(cp)) score += 1;
    }
    if (score > bestScore) {
      best = face;
      bestScore = score;
    }
  }
  return best;
}

/** Actual ink bounds for shaped text, in PDF points relative to its baseline/origin. */
export type PayslipTextBounds = { ascent: number; descent: number; left: number; right: number };

/**
 * Reuse the fontkit font already parsed by pdf-lib, without loading or parsing a second font.
 * pdf-lib 1.17's custom embedder retains this font; guard that integration rather than assuming it.
 * Whole-font metrics are deliberately the conservative fallback for standard fonts or absent bounds.
 * Match CustomFontEmbedder exactly: it emits layout glyph IDs at one baseline and advances each glyph
 * by advanceWidth; it does not apply fontkit position offsets. Missing/non-finite glyphs cannot report
 * a small successful box.
 */
export function measurePayslipTextBounds(font: PDFFont, text: string, size: number, options: { inkOnly?: boolean } = {}): PayslipTextBounds {
  const conservative = (): PayslipTextBounds => {
    const height = font.heightAtSize(size);
    return { ascent: height, descent: height, left: 0, right: font.widthOfTextAtSize(text, size) };
  };
  type Glyph = { id: number; advanceWidth: number; path?: { commands: unknown[] }; bbox: { minX: number; minY: number; maxX: number; maxY: number } };
  const parsed = (font as unknown as { embedder?: { font?: {
    unitsPerEm: number;
    layout?: (value: string) => { glyphs: Glyph[] };
  } } }).embedder?.font;
  if (!text) return { ascent: 0, descent: 0, left: 0, right: 0 };
  if (!parsed?.layout || !Number.isFinite(parsed.unitsPerEm) || parsed.unitsPerEm <= 0) return conservative();
  try {
    const shaped = parsed.layout(text);
    if (shaped.glyphs.length === 0) return conservative();
    let cursorX = 0;
    // Layout fitting normally includes the origin/baseline conservatively. Optical centring
    // may instead request only the union of actual glyph outlines, excluding empty space.
    let left = options.inkOnly ? Infinity : 0;
    let right = options.inkOnly ? -Infinity : 0;
    let bottom = options.inkOnly ? Infinity : 0;
    let top = options.inkOnly ? -Infinity : 0;
    for (let i = 0; i < shaped.glyphs.length; i += 1) {
      const glyph = shaped.glyphs[i];
      if (glyph.id === 0) return { ascent: Infinity, descent: Infinity, left: -Infinity, right: Infinity };
      if (glyph.bbox.minX === Infinity && glyph.bbox.minY === Infinity
          && glyph.bbox.maxX === -Infinity && glyph.bbox.maxY === -Infinity
          && glyph.path?.commands.length === 0 && Number.isFinite(glyph.advanceWidth)) {
        // Fontkit's space glyph has no outline and canonical empty bounds, but still advances.
        cursorX += glyph.advanceWidth;
        continue;
      }
      const values = [glyph.bbox.minX, glyph.bbox.maxX, glyph.bbox.minY, glyph.bbox.maxY,
        glyph.advanceWidth];
      if (!values.every(Number.isFinite)) return conservative();
      left = Math.min(left, cursorX + glyph.bbox.minX);
      right = Math.max(right, cursorX + glyph.bbox.maxX);
      bottom = Math.min(bottom, glyph.bbox.minY);
      top = Math.max(top, glyph.bbox.maxY);
      cursorX += glyph.advanceWidth;
    }
    if (options.inkOnly && left === Infinity) return { ascent: 0, descent: 0, left: 0, right: 0 };
    const scale = size / parsed.unitsPerEm;
    return { ascent: top * scale, descent: -bottom * scale, left: left * scale, right: right * scale };
  } catch {
    return conservative();
  }
}
