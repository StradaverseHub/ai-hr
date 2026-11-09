"""Strict archive data inspection for one fixed browser toolchain.

Callers must supply exclusively held, immutable, seekable archive bytes.
This module cannot establish that custody and performs no transfer,
extraction, installation, or executable admission.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import stat
import struct
import tarfile
import time
import zlib
from dataclasses import dataclass

MIB = 1024 * 1024
CHUNK = 256 * 1024
ZIP_MAX = 256 * MIB
ZIP_EXPANDED_MAX = 512 * MIB
ZIP_MEMBER_MAX = 384 * MIB
ZIP_COUNT_MAX = 1024
ZIP_DIRECTORY_MAX = 2 * MIB
PACKAGE_MAX = 16 * MIB
TAR_MAX = 64 * MIB
PACKAGE_MEMBER_MAX = 32 * MIB
PACKAGE_COUNT_MAX = 4096
MANIFEST_MAX = 64 * 1024
TAR_PADDING_MAX = 10240
ELF_PREFIX_MAX = 32 * 1024
ZIP_END = struct.Struct('<4s4H2IH')
ZIP_CENTRAL = struct.Struct('<4s6H3I5H2I')
ZIP_LOCAL = struct.Struct('<4s5H3I2H')
ELF_HEADER = struct.Struct('<16sHHIQQQIHHHHHH')
ELF_PROGRAM = struct.Struct('<IIQQQQQQ')

BROWSER_VERSION = '151.0.7922.34'
BROWSER_REVISION = '1234'
BROWSER_ARCHIVE_BYTES = 120231126
BROWSER_ARCHIVE_SHA = '3cfc2bd00d1bafcf8a68dc74c9c92bb7150ddc8d26ade948a776316e1cec4f14'
BROWSER_TREE_SHA = '285519f831cfb38f59102de01929448b7229153f469470b68b9459892d1bbf7e'
BROWSER_ARCHIVE_FILES = 287
BROWSER_TREE_ENTRIES = 290
BROWSER_EXPANDED_BYTES = 273378828
BROWSER_ROOT = 'chrome-headless-shell-linux64'
BROWSER_EXECUTABLE = BROWSER_ROOT + '/chrome-headless-shell'
BROWSER_EXECUTABLE_BYTES = 196975952
BROWSER_EXECUTABLE_SHA = 'e11fc9ce65c96313476f7ee9844b6fb6a9220fb048693cfe9eee00acf4170a9f'
PACKAGES = {
    'playwright': ('1.62.1', 'sha512-0M+L3LAD8/nm554LOla9Ayx0j0tmFZ0FBcoQ7F1VuVHpM/XpiC8RcDzBQB8W5+hA8L22THxELzeF+2WcUzvcLg=='),
    'playwright-core': ('1.62.1', 'sha512-wPYSwEBJY9GHraISXqyqtx0na0LpO3XEX7jNDhntbex7tzUS7kLnZsOlFruFJB4Hi/rhDMjXGqHewDZ68nYZVw=='),
    'postgres': ('3.4.9', 'sha512-GD3qdB0x1z9xgFI6cdRD6xu2Sp2WCOEoe3mtnyB5Ee0XrrL5Pe+e4CCnJrRMnL1zYtRDZmQQVbvOttLnKDLnaw=='),
}
ZIP_EXTRAS = frozenset((0x000a, 0x5455, 0x5855, 0x7875))
PART = re.compile(rb'[A-Za-z0-9._+@-]+')


class ArchiveRefused(ValueError):
    """A fixed grammar or pin mismatch, with no input bytes in the message."""


def require(condition, reason):
    if not condition:
        raise ArchiveRefused(reason)


def remaining(deadline):
    require(time.monotonic() < deadline, 'archive inspection deadline exhausted')


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True,
                       allow_nan=False) + '\n').encode()


def read_exact(source, count):
    data = source.read(count)
    require(len(data) == count, 'truncated archive extent')
    return data


def chunks(source, size, deadline):
    while size:
        remaining(deadline)
        data = read_exact(source, min(CHUNK, size))
        size -= len(data)
        yield data


def archive_hash(source, maximum, algorithm, deadline, exact_size=None):
    size = source.seek(0, os.SEEK_END)
    require(0 < size <= maximum and (exact_size is None or size == exact_size), 'archive byte bound differs')
    source.seek(0)
    digest = hashlib.new(algorithm)
    for block in chunks(source, size, deadline):
        digest.update(block)
    require(source.read(1) == b'', 'archive extent changed')
    return size, digest.digest()


def inflate(blocks, window, maximum, deadline):
    decoder = zlib.decompressobj(window)
    total = 0

    def decode(pending):
        nonlocal total
        remaining(deadline)
        try:
            decoded = decoder.decompress(pending, min(CHUNK, maximum - total + 1))
        except zlib.error:
            raise ArchiveRefused('invalid compressed stream') from None
        total += len(decoded)
        require(total <= maximum and not decoder.unused_data, 'compressed stream exceeds its exact extent')
        return decoded

    for pending in blocks:
        require(not decoder.eof, 'compressed stream ended before its extent')
        while pending:
            output = decode(pending)
            tail = decoder.unconsumed_tail
            require(output or len(tail) < len(pending), 'compressed decoder made no progress')
            if output:
                yield output
            pending = tail

    while not decoder.eof:
        output = decode(b'')
        require(output or decoder.eof, 'compressed stream has no natural end')
        if output:
            yield output
    require(not decoder.unused_data and not decoder.unconsumed_tail, 'compressed stream has trailing input')


def relative_path(raw, root, *, directory=False):
    if directory and raw.endswith(b'/'):
        raw = raw[:-1]
    parts = raw.split(b'/')
    require(0 < len(raw) <= 255 and 1 <= len(parts) <= 12 and parts[0] == root
            and (directory or len(parts) > 1)
            and all(part not in (b'.', b'..') and PART.fullmatch(part) for part in parts),
            'archive member path is invalid')
    return raw.decode('ascii')


def file_mode(value):
    require(not value & 0o7000, 'privileged archive mode refused')
    return 0o555 if value & 0o111 else 0o444


def with_parents(rows, maximum):
    require(0 < len(rows) <= maximum, 'archive tree entry bound')
    result = dict(rows)
    for name in rows:
        parts = name.split('/')
        for depth in range(1, len(parts)):
            parent = '/'.join(parts[:depth])
            existing = result.setdefault(parent, (parent, 'directory', 0o555, 0, None))
            require(existing[1] == 'directory' and len(result) <= maximum, 'archive tree collision or bound')
    return [result[name] for name in sorted(result)]


def zip_extras(data):
    seen = set()
    offset = 0
    while offset < len(data):
        require(len(data) - offset >= 4, 'truncated ZIP extra header')
        kind, size = struct.unpack_from('<HH', data, offset)
        offset += 4 + size
        require(kind in ZIP_EXTRAS and kind not in seen and offset <= len(data), 'unsupported ZIP extra')
        seen.add(kind)


@dataclass(frozen=True)
class ZipEntry:
    name: bytes
    version: int
    flags: int
    method: int
    clock: int
    date: int
    crc: int
    compressed: int
    expanded: int
    mode: int
    offset: int


def zip_directory(source, size, deadline):
    end = size - ZIP_END.size
    require(end >= 20, 'missing classic ZIP end')
    source.seek(end - 20)
    require(read_exact(source, 4) != b'PK\x06\x07', 'ZIP64 locator refused')
    source.seek(end)
    marker, disk, central_disk, disk_count, count, span, offset, comment = ZIP_END.unpack(read_exact(source, ZIP_END.size))
    require(marker == b'PK\x05\x06' and disk == central_disk == comment == 0 and disk_count == count
            and 0 < count <= ZIP_COUNT_MAX and 0 < span <= ZIP_DIRECTORY_MAX and 0 < offset < end
            and offset + span == end, 'invalid classic ZIP directory')
    source.seek(offset)
    entries = {}
    expanded = 0
    for _ in range(count):
        remaining(deadline)
        require(source.tell() + ZIP_CENTRAL.size <= end, 'truncated ZIP central entry')
        (marker, _created, version, flags, method, clock, date, crc, compressed, decoded, name_size,
         extra_size, comment_size, disk_start, _internal, external, local) = ZIP_CENTRAL.unpack(read_exact(source, ZIP_CENTRAL.size))
        require(marker == b'PK\x01\x02' and 0 < version < 45 and disk_start == comment_size == 0
                and method in (0, 8) and not flags & ~(0x0808 if method == 0 else 0x080e)
                and 0 < name_size <= 255 and extra_size <= 4096
                and source.tell() + name_size + extra_size <= end
                and local + ZIP_LOCAL.size + compressed <= offset and decoded <= ZIP_MEMBER_MAX
                and (method != 0 or compressed == decoded), 'unsupported ZIP central entry')
        name = read_exact(source, name_size)
        zip_extras(read_exact(source, extra_size))
        path = relative_path(name, BROWSER_ROOT.encode())
        mode = external >> 16
        require(not external & 0x18, 'ZIP DOS type disagrees with regular member')
        require(path not in entries and stat.S_IFMT(mode) in (0, stat.S_IFREG), 'duplicate or nonregular ZIP member')
        expanded += decoded
        require(expanded <= ZIP_EXPANDED_MAX, 'expanded ZIP bound exceeded')
        entries[path] = ZipEntry(name, version, flags, method, clock, date, crc, compressed, decoded, file_mode(mode), local)
    require(source.tell() == end, 'actual ZIP central count differs')
    return entries, offset


def zip_data_offset(source, entry, next_offset):
    source.seek(entry.offset)
    (marker, version, flags, method, clock, date, crc, compressed, decoded,
     name_size, extra_size) = ZIP_LOCAL.unpack(read_exact(source, ZIP_LOCAL.size))
    require(marker == b'PK\x03\x04' and (version, flags, method, clock, date) ==
            (entry.version, entry.flags, entry.method, entry.clock, entry.date)
            and name_size == len(entry.name) and extra_size <= 4096
            and source.tell() + name_size + extra_size + entry.compressed <= next_offset,
            'ZIP local header differs')
    require(read_exact(source, name_size) == entry.name, 'ZIP local member name differs')
    zip_extras(read_exact(source, extra_size))
    start = source.tell()
    payload_end = start + entry.compressed
    expected = entry.crc, entry.compressed, entry.expanded
    if flags & 8:
        require((crc, compressed, decoded) in ((0, 0, 0), expected)
                and next_offset - payload_end in (12, 16), 'ZIP descriptor extent differs')
        source.seek(payload_end)
        if next_offset - payload_end == 16:
            require(read_exact(source, 4) == b'PK\x07\x08', 'ZIP descriptor signature differs')
        require(struct.unpack('<III', read_exact(source, 12)) == expected, 'ZIP descriptor values differ')
    else:
        require(payload_end == next_offset and (crc, compressed, decoded) == expected, 'ZIP local values or extent differ')
    return start


def verify_elf(prefix, size):
    require(len(prefix) >= ELF_HEADER.size, 'browser ELF header missing')
    (ident, kind, machine, version, entry, phoff, _shoff, _flags, ehsize,
     phentsize, phnum, _shentsize, _shnum, _shindex) = ELF_HEADER.unpack_from(prefix)
    require(ident[:7] == b'\x7fELF\x02\x01\x01' and kind in (2, 3) and machine == 62 and version == 1
            and ehsize == ELF_HEADER.size and phentsize == ELF_PROGRAM.size
            and 0 < phnum <= 128 and ELF_HEADER.size <= phoff <= 4096
            and phoff + phnum * phentsize <= len(prefix), 'browser ELF program table differs')
    executable = False
    interpreter = None
    for index in range(phnum):
        program = ELF_PROGRAM.unpack_from(prefix, phoff + index * phentsize)
        typ, flags, offset, address, _physical, filesz, memsz, _align = program
        require(offset + filesz <= size, 'browser ELF program extent differs')
        if typ == 1:
            require(filesz <= memsz and flags & 3 != 3, 'browser ELF load permissions differ')
            executable |= bool(flags & 1 and filesz and address <= entry < address + filesz)
        if typ == 3:
            require(interpreter is None and 0 < filesz <= 128 and offset + filesz <= len(prefix), 'browser ELF interpreter extent differs')
            interpreter = prefix[offset:offset + filesz]
    require(executable and interpreter == b'/lib64/ld-linux-x86-64.so.2\0', 'browser ELF executable mapping differs')


def zip_rows(source, size, deadline):
    entries, central_start = zip_directory(source, size, deadline)
    ordered = sorted(entries, key=lambda path: entries[path].offset)
    require(entries[ordered[0]].offset == 0, 'ZIP has a local preamble')
    rows = {}
    for index, path in enumerate(ordered):
        entry = entries[path]
        end = entries[ordered[index + 1]].offset if index + 1 < len(ordered) else central_start
        require(entry.offset + ZIP_LOCAL.size <= end, 'ZIP local members overlap')
        start = zip_data_offset(source, entry, end)
        source.seek(start)
        data = chunks(source, entry.compressed, deadline)
        if entry.method == 8:
            data = inflate(data, -zlib.MAX_WBITS, entry.expanded, deadline)
        length, crc = 0, 0
        digest, prefix = hashlib.sha256(), bytearray()
        for block in data:
            length += len(block)
            crc = zlib.crc32(block, crc)
            digest.update(block)
            if path == BROWSER_EXECUTABLE and len(prefix) < ELF_PREFIX_MAX:
                prefix.extend(block[:ELF_PREFIX_MAX - len(prefix)])
        require(length == entry.expanded and crc == entry.crc and source.tell() == start + entry.compressed,
                'ZIP member length, consumption or CRC differs')
        if path == BROWSER_EXECUTABLE:
            require(entry.mode == 0o555, 'browser ELF is not executable')
            verify_elf(prefix, length)
        rows[path] = (path, 'file', entry.mode, length, digest.hexdigest())
    return rows


def inspect_chromium(source, deadline):
    size, digest = archive_hash(source, ZIP_MAX, 'sha256', deadline, BROWSER_ARCHIVE_BYTES)
    require(hmac.compare_digest(digest.hex(), BROWSER_ARCHIVE_SHA), 'pinned browser archive SHA-256 differs')
    files = zip_rows(source, size, deadline)
    rows = with_parents(files, ZIP_COUNT_MAX)
    executable = files.get(BROWSER_EXECUTABLE)
    require(len(files) == BROWSER_ARCHIVE_FILES and len(rows) == BROWSER_TREE_ENTRIES
            and sum(row[3] for row in rows) == BROWSER_EXPANDED_BYTES
            and hashlib.sha256(canonical(rows)).hexdigest() == BROWSER_TREE_SHA
            and executable == (BROWSER_EXECUTABLE, 'file', 0o555, BROWSER_EXECUTABLE_BYTES, BROWSER_EXECUTABLE_SHA),
            'pinned browser tree differs')
    remaining(deadline)
    return rows


class TarStream:
    def __init__(self, blocks):
        self.blocks = iter(blocks)
        self.pending = memoryview(b'')

    def take(self, size):
        require(0 <= size <= CHUNK, 'tar read bound differs')
        result = bytearray()
        while len(result) < size:
            if not self.pending:
                self.pending = memoryview(next(self.blocks, b''))
                require(self.pending, 'truncated tar extent')
            count = min(size - len(result), len(self.pending))
            result.extend(self.pending[:count])
            self.pending = self.pending[count:]
        return bytes(result)

    def finish(self):
        # Exhaust the gzip decoder as well as the tar reader. A tar end marker
        # alone cannot show that the compressed member ended at physical EOF.
        total = len(self.pending)
        require(not any(self.pending), 'trailing tar content')
        for block in self.blocks:
            total += len(block)
            require(total <= TAR_PADDING_MAX and not any(block), 'trailing tar content or bound')
        require(total <= TAR_PADDING_MAX and total % 512 == 0, 'trailing tar alignment or bound')


def tar_text(field):
    value, marker, tail = field.partition(b'\0')
    require(not marker or not any(tail), 'tar name has trailing bytes')
    return value


def tar_octal(field):
    match = re.fullmatch(rb' *([0-7]+)[ \0]+', field)
    require(match is not None, 'non-octal tar field')
    return int(match[1], 8)


def tar_header(header):
    kind = header[156:157]
    require(len(header) == 512 and header[257:265] == b'ustar\0' + b'00'
            and kind in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE)
            and not any(header[157:257]), 'unsupported tar entry')
    require(not any(header[500:512]), 'nonzero tar reserved padding')
    raw = tuple(tar_octal(header[start:end]) for start, end in (
        (100, 108), (108, 116), (116, 124), (124, 136), (136, 148), (148, 156)))
    # Device fields are unused for the admitted kinds. Allow all-NUL fields
    # or the same complete-field octal encoding of zero.
    devices = tuple(tar_octal(field) if any(field) else 0 for field in (header[329:337], header[337:345]))
    require(devices == (0, 0), 'tar device fields must be zero')
    try:
        info = tarfile.TarInfo.frombuf(header, 'ascii', 'strict')
    except (tarfile.HeaderError, UnicodeError, ValueError):
        raise ArchiveRefused('invalid tar header') from None
    require(raw == (info.mode, info.uid, info.gid, info.size, info.mtime, info.chksum)
            and devices == (info.devmajor, info.devminor), 'tar decoded numeric fields differ')
    require(info.type == kind, 'tar entry type was reinterpreted')
    name, prefix = tar_text(header[:100]), tar_text(header[345:500])
    directory = kind == tarfile.DIRTYPE
    path = relative_path(prefix + b'/' + name if prefix else name, b'package', directory=directory)
    require('node_modules' not in path.split('/') and 0 <= info.size <= PACKAGE_MEMBER_MAX
            and (not directory or info.size == 0), 'unsupported tar member extent')
    mode = file_mode(info.mode)
    return path, directory, 0o555 if directory else mode, info.size


def package_rows(source, archive_size, deadline, expected_digest, maximum=PACKAGE_COUNT_MAX):
    source.seek(0)
    consumed_digest = hashlib.sha512()

    def compressed_blocks():
        for block in chunks(source, archive_size, deadline):
            immutable = bytes(block)
            consumed_digest.update(immutable)
            yield immutable

    stream = TarStream(inflate(compressed_blocks(), 16 + zlib.MAX_WBITS, TAR_MAX, deadline))
    rows, manifests = {}, {}
    while True:
        remaining(deadline)
        header = stream.take(512)
        if header == bytes(512):
            require(stream.take(512) == bytes(512), 'missing second tar terminator')
            stream.finish()
            break
        path, directory, mode, size = tar_header(header)
        require(path not in rows and len(rows) < maximum, 'duplicate tar member or bound')
        if directory:
            rows[path] = (path, 'directory', mode, 0, None)
            continue
        wanted = path in ('package/package.json', 'package/browsers.json')
        require(not wanted or size <= MANIFEST_MAX, 'tool manifest bound exceeded')
        digest, manifest = hashlib.sha256(), bytearray()
        length = size
        while length:
            remaining(deadline)
            data = stream.take(min(CHUNK, length))
            length -= len(data)
            digest.update(data)
            if wanted:
                manifest.extend(data)
        require(not any(stream.take((-size) % 512)), 'nonzero tar member padding')
        rows[path] = (path, 'file', mode, size, digest.hexdigest())
        if wanted:
            manifests[path] = bytes(manifest)
    require(rows, 'empty tool package')
    remaining(deadline)
    require(source.read(1) == b'', 'package compressed extent changed')
    require(hmac.compare_digest(consumed_digest.digest(), expected_digest), 'parsed package SHA-512 differs')
    return rows, manifests


def json_object(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'duplicate tool manifest key')
            result[key] = value
        return result

    def bad_constant(_value):
        raise ArchiveRefused('invalid tool manifest constant')

    try:
        result = json.loads(raw.decode('utf-8'), object_pairs_hook=unique, parse_constant=bad_constant)
    except (UnicodeError, ValueError, RecursionError):
        raise ArchiveRefused('invalid tool manifest JSON') from None
    require(type(result) is dict, 'tool manifest must be an object')
    return result


def package_entrypoints(name, version, rows, manifests):
    raw = manifests.get('package/package.json')
    require(raw is not None, 'tool package manifest is missing')
    value = json_object(raw)
    require(value.get('name') == name and value.get('version') == version, 'tool package identity differs')
    exports = value.get('exports')
    require(type(exports) is dict, 'tool package exports differ')
    if name == 'postgres':
        require(value.get('type') == 'module' and value.get('main') == 'cjs/src/index.js'
                and exports.get('import') == './src/index.js' and exports.get('default') == './cjs/src/index.js',
                'Postgres package entrypoints differ')
        required = ('src/index.js', 'cjs/src/index.js')
    else:
        root = exports.get('.')
        require(type(root) is dict and root.get('import') == './index.mjs' and root.get('require') == './index.js',
                'Playwright package entrypoints differ')
        required = ('index.mjs', 'index.js')
        if name == 'playwright':
            require(value.get('dependencies') == {'playwright-core': version}
                    and value.get('optionalDependencies') == {'fsevents': '2.3.2'}, 'Playwright dependency closure differs')
        else:
            required += ('browsers.json', 'lib/coreBundle.js')
            raw_browser = manifests.get('package/browsers.json')
            require(raw_browser is not None, 'Playwright browser manifest is missing')
            browsers = json_object(raw_browser).get('browsers')
            require(type(browsers) is list and all(type(row) is dict for row in browsers), 'Playwright browser manifest differs')
            shells = [row for row in browsers if row.get('name') == 'chromium-headless-shell']
            require(len(shells) == 1 and shells[0].get('revision') == BROWSER_REVISION
                    and shells[0].get('browserVersion') == BROWSER_VERSION, 'Playwright browser identity differs')
    if name != 'playwright':
        require(not value.get('dependencies') and not value.get('optionalDependencies'), 'tool package dependency closure differs')
    require(all(rows.get('package/' + path, (None, None))[1] == 'file' for path in required),
            'tool package entrypoint file missing')


def inspect_package(name, source, deadline, *, maximum=PACKAGE_COUNT_MAX):
    require(type(name) is str and name in PACKAGES, 'unknown tool package')
    require(type(maximum) is int and 0 < maximum <= PACKAGE_COUNT_MAX, 'tool package entry budget exhausted')
    version, integrity = PACKAGES[name]
    size, digest = archive_hash(source, PACKAGE_MAX, 'sha512', deadline)
    require(hmac.compare_digest('sha512-' + base64.b64encode(digest).decode('ascii'), integrity),
            'locked package SHA-512 differs')
    files, manifests = package_rows(source, size, deadline, digest, maximum)
    package_entrypoints(name, version, files, manifests)
    rows = with_parents(files, maximum)
    remaining(deadline)
    return rows


def inspect_toolchain(chromium, playwright, playwright_core, postgres, deadline):
    browser_rows = inspect_chromium(chromium, deadline)
    package_trees = {}
    budget = PACKAGE_COUNT_MAX
    for name, source in (('playwright', playwright), ('playwright-core', playwright_core), ('postgres', postgres)):
        rows = inspect_package(name, source, deadline, maximum=budget)
        package_trees[name] = rows
        budget -= len(rows)
    return {'chromium': browser_rows, 'packages': package_trees}
