import { inflateRawSync } from 'node:zlib';
import { SaxesParser } from 'saxes';

export type SpreadsheetArchiveLimits = Readonly<{ maxBytes: number; maxExpandedBytes: number; maxEntries: number }>;
export type SpreadsheetRelationship = Readonly<{ id: string; type: string; target: string; part: string }>;
export type SpreadsheetArchive = Readonly<{
  parts: ReadonlyMap<string, Buffer>;
  /** Key is the source part; the empty string denotes package-level relationships. */
  relationships: ReadonlyMap<string, readonly SpreadsheetRelationship[]>;
}>;
export class SpreadsheetArchiveError extends Error {
  constructor(public readonly code: 'tooLarge' | 'invalidArchive' | 'expandedLimit' | 'unsafeRelationship') {
    super(`spreadsheet-archive:${code}`); this.name = 'SpreadsheetArchiveError';
  }
}
const invalid = (): never => { throw new SpreadsheetArchiveError('invalidArchive'); };
const unsafeRelationship = (): never => { throw new SpreadsheetArchiveError('unsafeRelationship'); };
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

/** Decode the encodings supported by OOXML without silently replacing malformed bytes. */
export function decodeSpreadsheetXml(bytes: Buffer): string {
  try {
    const bigEndian = bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0 && bytes[1] === 0x3c;
    const littleEndian = bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0x3c && bytes[1] === 0;
    return new TextDecoder(bigEndian ? 'utf-16be' : littleEndian ? 'utf-16le' : 'utf-8', { fatal: true }).decode(bytes);
  } catch { return invalid(); }
}

function relationshipSource(name: string): string {
  if (name === '_rels/.rels') return '';
  const match = /^(.*\/)?_rels\/([^/]+)\.rels$/.exec(name);
  if (!match) return unsafeRelationship();
  return `${match[1] ?? ''}${match[2]}`;
}
function targetPart(source: string, target: string): string {
  if (!target || /[\\\x00-\x20?#]/.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) return unsafeRelationship();
  let decoded: string;
  try { decoded = decodeURIComponent(target); } catch { return unsafeRelationship(); }
  // Percent-encoded separators and URI syntax must not create another interpretation downstream.
  if (/[\\\x00-\x1f?#:]/.test(decoded) || /%2f|%5c/i.test(target)) return unsafeRelationship();
  const segments = target.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const segment of decoded.replace(/^\//, '').split('/')) {
    if (!segment || segment === '.') return unsafeRelationship();
    if (segment === '..') { if (!segments.length) return unsafeRelationship(); segments.pop(); }
    else segments.push(segment);
  }
  return segments.join('/');
}
function readRelationships(parts: ReadonlyMap<string, Buffer>): ReadonlyMap<string, readonly SpreadsheetRelationship[]> {
  const all = new Map<string, readonly SpreadsheetRelationship[]>();
  for (const [name, bytes] of parts) {
    if (!/\.rels$/i.test(name)) continue;
    const source = relationshipSource(name);
    if (source && !parts.has(source) || all.has(source)) return unsafeRelationship();
    const rows: SpreadsheetRelationship[] = [], ids = new Set<string>();
    const parser = new SaxesParser({ xmlns: true }); let depth = 0;
    parser.on('doctype', unsafeRelationship);
    parser.on('opentag', tag => {
      depth++;
      if (tag.uri !== 'http://schemas.openxmlformats.org/package/2006/relationships' || (depth === 1 ? tag.local !== 'Relationships' : depth !== 2 || tag.local !== 'Relationship')) return unsafeRelationship();
      if (depth === 1) return;
      const attributes = Object.fromEntries(Object.values(tag.attributes).filter(attribute => !attribute.uri).map(attribute => [attribute.local, attribute.value]));
      if (!attributes.Id || ids.has(attributes.Id) || !attributes.Type || attributes.TargetMode && attributes.TargetMode !== 'Internal') return unsafeRelationship();
      if (/vbaProject|macroSheet|externalLink|oleObject|package$/i.test(attributes.Type)) return unsafeRelationship();
      const part = targetPart(source, attributes.Target ?? '');
      if (!parts.has(part) || part.endsWith('/')) return unsafeRelationship();
      ids.add(attributes.Id); rows.push({ id: attributes.Id, type: attributes.Type, target: attributes.Target, part });
    });
    parser.on('closetag', () => { depth--; });
    parser.on('text', value => { if (value.trim()) return unsafeRelationship(); });
    try { parser.write(decodeSpreadsheetXml(bytes)).close(); } catch { return unsafeRelationship(); }
    all.set(source, rows);
  }
  return all;
}

/** Strict ordinary ZIP admission before a spreadsheet parser can allocate from untrusted metadata.
 * This owns archive/relationship safety only. Formula and protection rules belong to each adapter. */
export function readSpreadsheetArchive(bytes: Buffer, limits: SpreadsheetArchiveLimits): SpreadsheetArchive {
  if (bytes.length > limits.maxBytes) throw new SpreadsheetArchiveError('tooLarge');
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return invalid();
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) return invalid();
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16);
  if (!count || count > limits.maxEntries || bytes.readUInt16LE(end + 8) !== count || start > end || bytes.readUInt32LE(end + 12) !== end - start) return invalid();
  const checkExtras = (offset: number, length: number) => {
    const limit = offset + length;
    while (offset < limit) {
      if (offset + 4 > limit) return invalid();
      const tag = bytes.readUInt16LE(offset), size = bytes.readUInt16LE(offset + 2);
      if (tag === 0x0001 || tag === 0x7075 || offset + 4 + size > limit) return invalid();
      offset += 4 + size;
    }
  };
  let offset = start, expanded = 0;
  const parts = new Map<string, Buffer>(), foldedNames = new Set<string>(), ranges: { start: number; end: number }[] = [];
  for (let n = 0; n < count; n++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) return invalid();
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24), nameLength = bytes.readUInt16LE(offset + 28);
    const extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extra + comment;
    if (!nameLength || next > end || flags & ~0x080e || ![0, 8].includes(method) || bytes.readUInt16LE(offset + 34) || compressed === 0xffffffff || size === 0xffffffff || local + 30 > start) return invalid();
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    let name: string;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); } catch { return invalid(); }
    // Some workbook consumers case-fold package paths. Refuse aliases rather than selecting one.
    if (foldedNames.has(name.toLowerCase()) || /vbaProject|externalLinks|embeddings/i.test(name) || /[\\\x00:]/.test(name) || name.startsWith('/') || name.split('/').some(part => part === '.' || part === '..')) return invalid();
    foldedNames.add(name.toLowerCase());
    checkExtras(offset + 46 + nameLength, extra);
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 4) !== bytes.readUInt16LE(offset + 6) || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) return invalid();
    const localNameLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), dataStart = local + 30 + localNameLength + localExtra, dataEnd = dataStart + compressed;
    if (localNameLength !== nameLength || dataStart > start || dataEnd > start || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)) return invalid();
    checkExtras(local + 30 + localNameLength, localExtra);
    const localCrc = bytes.readUInt32LE(local + 14), localCompressed = bytes.readUInt32LE(local + 18), localSize = bytes.readUInt32LE(local + 22);
    let recordEnd = dataEnd;
    if (flags & 8) {
      if (localCrc !== 0 && localCrc !== crc || localCompressed !== 0 && localCompressed !== compressed || localSize !== 0 && localSize !== size) return invalid();
      const signed = dataEnd + 4 <= start && bytes.readUInt32LE(dataEnd) === 0x08074b50, descriptor = dataEnd + (signed ? 4 : 0);
      recordEnd = descriptor + 12;
      if (recordEnd > start || bytes.readUInt32LE(descriptor) !== crc || bytes.readUInt32LE(descriptor + 4) !== compressed || bytes.readUInt32LE(descriptor + 8) !== size) return invalid();
    } else if (localCrc !== crc || localCompressed !== compressed || localSize !== size) return invalid();
    if (size > limits.maxExpandedBytes - expanded) throw new SpreadsheetArchiveError('expandedLimit');
    const payload = bytes.subarray(dataStart, dataEnd); let actual: Buffer;
    try {
      if (method === 0) actual = payload;
      else {
        // Node's documented info option exposes input consumed by the inflater. A valid first
        // stream must not conceal trailing garbage or a second stream inside its declared payload.
        const result = inflateRawSync(payload, { maxOutputLength: Math.max(1, size), info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        if (result.engine.bytesWritten !== payload.length) return invalid();
        actual = result.buffer;
      }
    } catch { return invalid(); }
    if (actual.length !== size || crc32(actual) !== crc) return invalid();
    if (/\.(?:xml|rels)$/i.test(name)) {
      const xml = decodeSpreadsheetXml(actual), parser = new SaxesParser({ xmlns: true });
      parser.on('doctype', invalid);
      try { parser.write(xml).close(); } catch { return invalid(); }
      if (name === '[Content_Types].xml' && /macroEnabled|vbaProject|oleObject/i.test(xml)) return invalid();
    }
    expanded += actual.length; parts.set(name, actual); ranges.push({ start: local, end: recordEnd }); offset = next;
  }
  if (offset !== end) return invalid();
  ranges.sort((a, b) => a.start - b.start); let localEnd = 0;
  for (const range of ranges) { if (range.start !== localEnd) return invalid(); localEnd = range.end; }
  if (localEnd !== start || !parts.has('xl/workbook.xml')) return invalid();
  return { parts, relationships: readRelationships(parts) };
}
