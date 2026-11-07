"""Bounded Git object proof for the disposable native Next source copy.

Pure data verification. Git runs only in the unprivileged wrapper. Neither a
caller-created path inventory nor a HEAD marker authenticates source bytes.
This is not a release grant or a replacement for build-packet authentication.
"""
import base64
import hashlib
import re

MAX_TREES = 50000
MAX_ENTRIES = 500000
MAX_TREE_BYTES = 16 * 1024 * 1024
MAX_PROOF_BYTES = 64 * 1024 * 1024
OID = re.compile(r'[a-f0-9]{40}')


def object_id(kind, data):
    return hashlib.sha1(kind.encode() + b' ' + str(len(data)).encode() + b'\0' + data,
                        usedforsecurity=False).hexdigest()


def blob_id(data):
    return object_id('blob', data)


def verified_source(proof, candidate, require):
    """Return independently derived files; all supplied tree objects must belong.

    The exact trusted candidate SHA anchors the commit, its tree and every
    recursively reached tree/blob identity. No source code is imported/executed.
    """
    require(isinstance(candidate, str) and OID.fullmatch(candidate) is not None,
            'Native source candidate is invalid')
    require(isinstance(proof, dict) and set(proof) == {'version', 'source', 'commit', 'trees'}
            and type(proof['version']) is int and proof['version'] == 1 and proof['source'] == candidate,
            'Native source proof identity differs')
    total = 0
    def decode(value, ceiling, allow_empty=False):
        nonlocal total
        require(isinstance(value, str) and (bool(value) or allow_empty)
                and len(value) <= (ceiling + 2) // 3 * 4,
                'Native source object exceeds bound')
        try:
            raw = base64.b64decode(value, validate=True)
        except (ValueError, TypeError):
            require(False, 'Invalid native source object encoding')
        total += len(raw)
        require(len(raw) <= ceiling and total <= MAX_PROOF_BYTES,
                'Native source proof exceeds bound')
        return raw
    commit = decode(proof['commit'], 65536)
    require(object_id('commit', commit) == candidate, 'Native source commit bytes differ')
    first = commit.split(b'\n', 1)[0]
    require(re.fullmatch(rb'tree [a-f0-9]{40}', first) is not None, 'Native source commit tree missing')
    root = first[5:].decode('ascii')
    require(isinstance(proof['trees'], list) and 0 < len(proof['trees']) <= MAX_TREES,
            'Native source tree inventory exceeds bound')
    trees = {}
    for item in proof['trees']:
        require(isinstance(item, dict) and set(item) == {'oid', 'bytes'}
                and isinstance(item['oid'], str) and OID.fullmatch(item['oid']) is not None
                and item['oid'] not in trees, 'Native source tree identity differs')
        raw = decode(item['bytes'], MAX_TREE_BYTES, allow_empty=True)
        require(object_id('tree', raw) == item['oid'], 'Native source tree bytes differ')
        trees[item['oid']] = raw
    require(list(trees) == sorted(trees), 'Native source tree order differs')
    reached, paths, files, count = set(), set(), [], 0
    def walk(oid, prefix, ancestors):
        nonlocal count
        require(oid in trees and oid not in ancestors and len(ancestors) <= 128,
                'Native source tree missing or recursive')
        reached.add(oid)
        raw, offset, names = trees[oid], 0, set()
        while offset < len(raw):
            space, end = raw.find(b' ', offset), raw.find(b'\0', offset)
            require(offset < space < end and end + 21 <= len(raw), 'Native source tree record is truncated')
            mode, name = raw[offset:space], raw[space + 1:end]
            target = raw[end + 1:end + 21].hex()
            offset = end + 21
            require(name not in names and 0 < len(name) <= 255 and name not in (b'.', b'..', b'.git')
                    and b'/' not in name and b'\\' not in name
                    and not any(value < 32 or value == 127 for value in name), 'Unsafe native source member')
            names.add(name)
            try:
                path = prefix + name.decode('utf8')
            except UnicodeError:
                require(False, 'Invalid native source member encoding')
            count += 1
            require(count <= MAX_ENTRIES and len(path.encode()) <= 4096 and path not in paths,
                    'Native source path inventory exceeds bound')
            paths.add(path)
            if mode == b'40000':
                walk(target, path + '/', ancestors | {oid})
            else:
                # Current source has no tracked links or submodules. A future
                # such change needs its own explicit immutable package contract.
                require(mode in (b'100644', b'100755'), 'Unsupported native source member type')
                files.append({'path': path, 'blob': target, 'mode': 0o755 if mode == b'100755' else 0o644})
    walk(root, '', set())
    require(reached == set(trees) and files, 'Foreign or empty native source tree proof')
    return sorted(files, key=lambda item: item['path'])
