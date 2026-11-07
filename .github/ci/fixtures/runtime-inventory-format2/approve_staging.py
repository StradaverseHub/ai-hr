#!/usr/bin/env python3
"""Final operator staging acceptance -> immutable production packages. No deployment."""
import argparse
import datetime as dt
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shlex
import subprocess
import sys
import tarfile
from zoneinfo import ZoneInfo

REPOSITORY = 'StradaverseHub/ai-hr'
REPOSITORY_ID = 1333414856
RELEASE_REPOSITORY = 'StradaverseHub/ai-hr-releases'
RELEASE_REPOSITORY_ID = 1434418441
ROOT = Path(__file__).resolve().parents[2]
SHA = re.compile(r'^[0-9a-f]{40}$')
BUILD = re.compile(r'^[A-Za-z0-9_-]{1,100}$')
TAG = re.compile(r'^prod-(\d{4}-\d{2}-\d{2})\.([1-9]\d*)$')


def require(ok, message):
    if not ok:
        raise ValueError(message)


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs).stdout


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def save(path, value):
    temporary = path.with_suffix('.pending')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def date_in_kl(instant):
    return instant.astimezone(ZoneInfo('Asia/Kuala_Lumpur')).date().isoformat()


def next_tag(date, tags):
    numbers = [int(m[2]) for t in tags if (m := TAG.fullmatch(t)) and m[1] == date]
    return f'prod-{date}.{max(numbers, default=0) + 1}'


def private_path(name):
    p = PurePosixPath(name)
    return (any(x in {'.git', '.ssh', '.improve'} for x in p.parts)
            or p.name in {'runtime.env', 'deploy.env', 'provision.env', 'installation-secrets.json', '.npmrc'}
            or (p.name.startswith('.env') and not p.name.endswith(('.example', '.sample', '.template'))))


def audit_archive(path, runtime=False, build=None, lock=None):
    """Inspect without extraction; pnpm relative links must stay inside allowed roots."""
    names, files, links, special = set(), {}, [], {}
    total = 0
    with tarfile.open(path, 'r:gz') as archive:
        for item in archive:
            name = item.name.rstrip('/')
            require(name and not name.startswith('/') and '..' not in PurePosixPath(name).parts,
                    'Unsafe archive path')
            require(name not in names, 'Duplicate archive path: ' + name)
            names.add(name)
            require(len(names) <= 500000, 'Archive exceeds entry bound')
            require(not private_path(name), 'Private configuration in package: ' + name)
            if runtime:
                require(PurePosixPath(name).parts[0] in {'.next', 'node_modules'}, 'Unexpected runtime root')
                require(not any(name == p or name.startswith(p + '/') for p in
                                ('.next/cache', '.next/dev', '.next/trace', 'node_modules/.cache')),
                        'Application cache in runtime')
            require(item.isdir() or item.isfile() or item.issym() or item.islnk(), 'Special archive entry')
            if item.issym() or item.islnk():
                require(not item.linkname.startswith('/'), 'Absolute archive link')
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), item.linkname)
                                           if item.issym() else item.linkname)
                require(target != '..' and not target.startswith('../'), 'Escaping archive link')
                if runtime:
                    require(target.split('/')[0] in {'.next', 'node_modules'}, 'Escaping runtime link')
                require(not private_path(target), 'Private archive link')
                links.append((name, target))
            elif item.isfile():
                total += item.size
                require(total <= 8 * 1024**3 and len(names) <= 500000, 'Archive exceeds inventory bound')
                stream = archive.extractfile(item)
                h = hashlib.sha256()
                collect = name in {'.next/BUILD_ID', 'node_modules/.deploy-lockfile-sha', '.next/prerender-manifest.json'}
                require(not collect or item.size <= 4 * 1024**2, 'Oversized runtime identity')
                content = bytearray()
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    h.update(block)
                    if collect:
                        content.extend(block)
                files[name] = h.hexdigest()
                if collect:
                    special[name] = bytes(content)
        # Links through another symlink could escape even if each textual target looks safe.
        link_map = dict(links)
        for name, target in links:
            visited = {name}
            for _ in range(100):
                parts = target.split('/')
                prefix = next(('/'.join(parts[:i]) for i in range(1, len(parts)+1)
                               if '/'.join(parts[:i]) in link_map), None)
                if prefix is None:
                    break
                require(prefix not in visited, 'Cyclic archive link')
                visited.add(prefix)
                target = posixpath.normpath(link_map[prefix] + target[len(prefix):])
            else:
                raise ValueError('Archive link depth exceeded')
            require(target != '..' and not target.startswith('../') and not target.startswith('/'), 'Escaping link chain')
            require(not private_path(target), 'Private link chain')
            if runtime:
                require(target.split('/')[0] in {'.next', 'node_modules'}, 'Escaping runtime link chain')
    if runtime:
        require(special.get('.next/BUILD_ID', b'').decode().strip() == build, 'Runtime build ID mismatch')
        require(special.get('node_modules/.deploy-lockfile-sha', b'').decode().strip() == lock, 'Runtime lockfile mismatch')
        prerender = json.loads(special.get('.next/prerender-manifest.json', b'{}'))
        require('routes' in prerender and 'dynamicRoutes' in prerender, 'Missing prerender inventory')
        require(set(prerender['routes']) <= {'/_not-found', '/_global-error', '/404', '/500'},
                'Runtime contains prerendered application data; review before publication')
        require(not prerender['dynamicRoutes'], 'Runtime contains dynamic prerender data')
    require(files, 'Empty archive')
    return files


BUILD_ALIAS = re.compile(r'\.next/node_modules/(sharp|fontkit)-[a-f0-9]{8,64}')


def relativize_build_aliases(source, destination, directory):
    """CI-installed builds (.github/ci/build-bundle.py) link Next's two external-package aliases to
    absolute dependency paths under the installation directory. Repoint only those aliases to the same
    dependency relative to the package; every other link, and any alias aimed elsewhere, is left for
    audit_archive to refuse."""
    prefix = posixpath.normpath(directory) + '/node_modules/'
    rewritten = []
    with tarfile.open(source, 'r:gz') as captured, \
            tarfile.open(destination, 'w:gz', compresslevel=1, format=captured.format) as output:
        for item in captured:
            name = item.name.rstrip('/')
            target = posixpath.normpath(item.linkname) if item.issym() else ''
            if BUILD_ALIAS.fullmatch(name) and target.startswith(prefix):
                item.linkname = posixpath.relpath('node_modules/' + target[len(prefix):], posixpath.dirname(name))
                rewritten.append(name)
            output.addfile(item, captured.extractfile(item) if item.isfile() else None)
    return rewritten
