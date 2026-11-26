import 'server-only';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

/**
 * Board 66175cd2 — THE ONE PLACE THE KWSP LOGO IS READ OFF DISK, for Borang A and BBCD.
 *
 * The reporter asked for the official KWSP logo at the top left of both forms, as on their reference forms.
 * Plan r2 (26 Nov 2026): the file at `KWSP_LOGO_PATH` is KWSP's OWN crest, cropped (not traced, redrawn,
 * recoloured or upscaled) from the logo KWSP publishes on kwsp.gov.my; its source and SHA-256 are in
 * assets/kwsp/README.md. The vendor reproduction inside the reporter's reference PDFs is never used. Without
 * the file both forms still lay out their masthead correctly (the space is left blank).
 *
 * WHAT IS ACCEPTED: a complete, well-formed, non-interlaced PNG (pdf-lib embeds PNG without a native
 * dependency) whose shorter side is at least `KWSP_LOGO_MIN_PX` pixels, so the mark prints sharp at the
 * ~0.8 in it occupies (180 px across 0.78 in is about 230 dpi). Anything else — a missing file, another format, a truncated or corrupt file, a file
 * too small to print clearly — is NOT drawn, and the reason is logged once per process so the operator can
 * see why the logo is absent.
 *
 * ⚠️ THE STRUCTURE IS CHECKED IN FULL BEFORE pdf-lib SEES THE BYTES. Measured while building this: pdf-lib's
 * PNG decoder does not return on a truncated PNG — it spins — so a damaged file handed to it would hang the
 * download request instead of failing it. `kwspLogoRefusal` walks every chunk (bounds and CRC), requires
 * IHDR first, IDAT and a final IEND, and inflates the image data to exactly the size the header declares.
 *
 * The renderers scale it to fit its box keeping its proportions (`scaleToFit`), so it is never stretched.
 *
 * Cached once found (the bytes are an installed asset, not tenant data). A missing file is re-checked on the
 * next request, so dropping the official file in place takes effect without a restart.
 */
export const KWSP_LOGO_PATH = join('assets', 'kwsp', 'kwsp-logo.png');
/**
 * The shorter side, in pixels. 180 px across the ~0.78 in box prints at about 230 dpi, sharp on an office
 * printer. Plan r2 lowered it from 300: KWSP publishes its crest at 180 px, and an official 180 px crest beats
 * an empty box. A larger official copy can replace the file with no other change.
 */
export const KWSP_LOGO_MIN_PX = 180;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The PNG's pixel size from its IHDR chunk, or null when the bytes are not a PNG. Pure, for the test. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  // IHDR is always the first chunk: length(4) "IHDR"(4) width(4) height(4), big-endian.
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null;
  const u32 = (o: number) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  return { width: u32(16), height: u32(20) };
}

/** Upper bound on either side, so a hostile header cannot ask for an enormous inflate. */
const MAX_PX = 6000;
/** Samples per pixel for each PNG colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array, from: number, to: number): number {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Why a candidate logo file may not be printed, or null when it may. Pure, for the test. */
export function kwspLogoRefusal(bytes: Uint8Array): string | null {
  const size = pngSize(bytes);
  if (!size) return 'not a PNG file';
  const u32 = (o: number) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  // Walk every chunk: length, type, data, CRC — all inside the file, every CRC right.
  const idat: Uint8Array[] = [];
  let off = 8;
  let ended = false;
  let first = true;
  while (off < bytes.length) {
    if (off + 12 > bytes.length) return 'the PNG file is truncated';
    const len = u32(off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const end = off + 12 + len;
    if (end > bytes.length) return 'the PNG file is truncated';
    if (crc32(bytes, off + 4, off + 8 + len) !== u32(off + 8 + len)) return `the PNG file is damaged (bad ${type} checksum)`;
    if (first && type !== 'IHDR') return 'not a PNG file';
    first = false;
    if (type === 'IDAT') idat.push(bytes.subarray(off + 8, off + 8 + len));
    off = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended) return 'the PNG file is truncated';
  if (idat.length === 0) return 'the PNG file has no image data';
  const { width, height } = size;
  const [depth, colour, , , interlace] = [bytes[24], bytes[25], bytes[26], bytes[27], bytes[28]];
  if (!(colour in CHANNELS) || ![1, 2, 4, 8, 16].includes(depth)) return 'the PNG uses an unsupported pixel format';
  if (interlace !== 0) return 'the PNG is interlaced; save it without interlacing';
  if (width === 0 || height === 0 || width > MAX_PX || height > MAX_PX) return `${width}x${height} px is outside the accepted size`;
  if (Math.min(width, height) < KWSP_LOGO_MIN_PX) {
    return `${width}x${height} px is too small to print clearly (the shorter side must be at least ${KWSP_LOGO_MIN_PX} px)`;
  }
  // The image data must inflate to EXACTLY the size the header declares: one filter byte per row.
  const expected = height * (1 + Math.ceil((width * CHANNELS[colour] * depth) / 8));
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c))), { maxOutputLength: expected + 1 });
  } catch {
    return 'the PNG file is damaged (its image data does not decompress)';
  }
  if (raw.length !== expected) return 'the PNG file is damaged (its image data is the wrong size)';
  return null;
}

let cached: Uint8Array | null = null;
let warned = '';

/** The official KWSP logo's bytes, or null when no acceptable file is installed at `KWSP_LOGO_PATH`. */
export function readKwspLogo(): Uint8Array | null {
  if (cached) return cached;
  const full = join(process.cwd(), KWSP_LOGO_PATH);
  if (!existsSync(full)) return null;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(full));
  } catch {
    return null;
  }
  const refusal = kwspLogoRefusal(bytes);
  if (refusal) {
    if (warned !== refusal) {
      warned = refusal;
      console.warn(`[kwsp-logo] ${KWSP_LOGO_PATH} is not drawn on Borang A / BBCD: ${refusal}.`);
    }
    return null;
  }
  cached = bytes;
  return cached;
}
