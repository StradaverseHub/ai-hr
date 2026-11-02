"""Strict format3 lossless map transport; deployment authority remains external."""
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('regular_bundle', Path(__file__).with_name('build-bundle.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def map_copies(rows):
    """Derive references from logical bytes, never from caller-provided paths."""
    first, copies = {}, []
    for row in rows:
        if row['path'].endswith('.map'):
            key = row['size'], row['sha256']
            if key in first:
                copies.append({'path': row['path'], 'source': first[key]})
            else:
                first[key] = row['path']
    return copies


def logical_manifest(manifest):
    return {**{k:v for k,v in manifest.items() if k!='mapCopies'},
            'format':2, 'kind':'next-build-byte-bundle'}


def validate_manifest(manifest):
    base.require(isinstance(manifest,dict) and type(manifest.get('format')) is int
                 and manifest['format']==3 and manifest.get('kind')=='next-map-byte-bundle'
                 and 'mapCopies' in manifest, 'explicit map bundle required')
    base.validate_manifest(logical_manifest(manifest))
    base.require(manifest['mapCopies']==map_copies(manifest['files']), 'map copy inventory differs')
    return manifest


def read_manifest(path):
    path = Path(path)
    before = base.regular(path,base.MAX_MANIFEST,context='map-build-manifest',root=path.parent)
    fd = os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as stream:
        base.require(base.identity(os.fstat(stream.fileno()))==base.identity(before), 'manifest changed before read')
        data = stream.read(base.MAX_MANIFEST+1)
        base.require(len(data)<=base.MAX_MANIFEST
                     and base.identity(os.fstat(stream.fileno()))==base.identity(before), 'manifest changed during read')
    value = json.loads(data)
    base.require(data==base.canonical(value), 'noncanonical/duplicate manifest JSON')
    return validate_manifest(value)


def hash_map(file, expected, mode, path):
    fd = os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as stream:
        base.require(base.identity(os.fstat(stream.fileno()))==expected, 'map changed before hashing')
        reader = base.HashReader(stream)
        remaining = expected[2]
        while remaining:
            data = reader.read(min(remaining,1024*1024))
            base.require(data, 'truncated map during hashing')
            remaining -= len(data)
        base.require(not stream.read(1) and reader.count==expected[2]
                     and base.identity(os.fstat(stream.fileno()))==expected,
                     'map changed while hashing')
    return {'path':path,'size':expected[2],'sha256':reader.hash.hexdigest(),'mode':0o755 if mode&0o111 else 0o644}


def pack(source, output):
    source, output = Path(source).absolute(), Path(output).absolute()
    base.require(output.parent.resolve()==output.parent and not output.is_relative_to(source/'.next'),
                 'unsafe bundle output directory')
    files, directories, aliases = base.scan(source)
    owned = base.OwnedOutput(output)
    try:
        maps = {path:hash_map(source/'.next'/path,expected,mode,path)
                for path,expected,mode in files if path.endswith('.map')}
        copies = map_copies([maps[path] for path in sorted(maps)])
        omitted = {copy['path'] for copy in copies}
        rows = []
        archive = output/'build-bundle.tar.gz'
        with archive.open('xb') as raw, gzip.GzipFile(filename='',fileobj=raw,mode='wb',
                compresslevel=base.COMPRESSION_LEVEL,mtime=0) as gz, tarfile.open(fileobj=gz,mode='w',
                format=tarfile.USTAR_FORMAT,encoding='utf-8') as tar:
            for path,expected,mode in base.compression_order(files):
                if path in omitted:
                    rows.append(maps[path])
                    continue
                fd = os.open(source/'.next'/path,os.O_RDONLY|os.O_NOFOLLOW)
                with os.fdopen(fd,'rb') as stream:
                    base.require(base.identity(os.fstat(stream.fileno()))==expected, 'build changed before packaging')
                    info = tarfile.TarInfo(path)
                    info.size, info.mode = expected[2], 0o755 if mode&0o111 else 0o644
                    reader = base.HashReader(stream)
                    tar.addfile(info,reader)
                    base.require(reader.count==info.size and base.identity(os.fstat(stream.fileno()))==expected,
                                 'build changed during packaging')
                    row = {'path':path,'size':info.size,'mode':info.mode,'sha256':reader.hash.hexdigest()}
                    base.require(path not in maps or row==maps[path], 'map bytes changed after hashing')
                    rows.append(row)
        base.require(base.scan(source)==(files,directories,aliases), 'build inventory changed during packaging')
        rows.sort(key=lambda row:row['path'])
        base.regular(archive,base.MAX_ARCHIVE,context='compressed-map-archive',root=output)
        manifest = {'format':3,'kind':'next-map-byte-bundle','capacityProfile':dict(base.CAPACITY_PROFILE),
                    'platform':sys.platform,'nextBuildId':(source/'.next/BUILD_ID').read_text().strip(),
                    'files':rows,'directories':directories,'aliases':aliases,'mapCopies':copies,
                    'unpackedBytes':sum(row['size'] for row in rows),'archiveBytes':archive.stat().st_size,
                    'archiveSha256':base.digest_file(archive)}
        validate_manifest(manifest)
        data = base.canonical(manifest)
        base.require(len(data)<=base.MAX_MANIFEST, 'manifest exceeds bound')
        with (output/'build-bundle-files.json').open('xb') as stream:
            stream.write(data)
        owned.assert_owned()
        return manifest
    except BaseException as error:
        owned.cleanup_after_failure(error)
        raise
    finally:
        owned.close()


def copy_map(source, destination, row):
    """Copy checked bytes into a new independent inode; never link or follow a source."""
    fd = os.open(source,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as stream:
        before = os.fstat(stream.fileno())
        base.require(stat.S_ISREG(before.st_mode) and before.st_size==row['size'], 'invalid map copy source')
        reader = base.HashReader(stream)
        remaining = row['size']
        with destination.open('xb') as target:
            while remaining:
                data = reader.read(min(remaining,1024*1024))
                base.require(data, 'truncated map copy source')
                target.write(data)
                remaining -= len(data)
        base.require(not stream.read(1) and reader.hash.hexdigest()==row['sha256']
                     and base.identity(os.fstat(stream.fileno()))==base.identity(before), 'map copy bytes differ')
    os.chmod(destination,row['mode'])
    installed = base.regular(destination,context='reconstructed-map',root=destination.parent)
    base.require(installed.st_size==row['size'] and installed.st_nlink==1
                 and stat.S_IMODE(installed.st_mode)==row['mode'], 'map copy metadata differs')
    base.require(hash_map(destination,base.identity(installed),row['mode'],row['path'])==row,
                 'map copy readback differs')


def unpack(archive, manifest_path, destination, runtime_source, producer_source=None):
    archive, manifest_path, destination, runtime_source = map(lambda p:Path(p).absolute(),
                                                            [archive,manifest_path,destination,runtime_source])
    manifest = read_manifest(manifest_path)
    before = base.regular(archive,base.MAX_ARCHIVE,context='compressed-map-archive',root=archive.parent)
    base.require(before.st_size==manifest['archiveBytes'] and base.digest_file(archive)==manifest['archiveSha256'],
                 'archive bytes differ')
    base.require(runtime_source.resolve()==runtime_source and runtime_source.is_dir(), 'canonical runtime source required')
    targets = {}
    for alias in manifest['aliases']:
        actual,target = base.package_identity(runtime_source,alias['package'],producer_source=producer_source)
        base.require(actual=={key:alias[key] for key in actual}, 'installed external package differs')
        targets[alias['path']] = target
    owned = base.OwnedOutput(destination)
    try:
        for directory in manifest['directories']:
            (destination/directory).mkdir(mode=0o755)
        rows = {row['path']:row for row in manifest['files']}
        omitted = {copy['path'] for copy in manifest['mapCopies']}
        base.extract_regular_files(archive,destination,{path:row for path,row in rows.items() if path not in omitted},before)
        for copy in manifest['mapCopies']:
            copy_map(destination/copy['source'],destination/copy['path'],rows[copy['path']])
        base.require((destination/'BUILD_ID').read_text().strip()==manifest['nextBuildId'], 'installed build ID differs')
        for alias in manifest['aliases']:
            actual,target = base.package_identity(runtime_source,alias['package'],producer_source=producer_source)
            base.require(actual=={key:alias[key] for key in actual} and target==targets[alias['path']],
                         'external package changed during extraction')
            (destination/alias['path']).symlink_to(target,target_is_directory=True)
        owned.assert_owned()
        return manifest
    except BaseException as error:
        owned.cleanup_after_failure(error)
        raise
    finally:
        owned.close()


def verify_directory(destination, manifest_path, runtime_source, producer_source=None, allow_runtime_cache=False):
    manifest = read_manifest(manifest_path)
    # A temporary private view reuses the existing full installed-file verifier;
    # it is not a format2 transport packet or a release-admission adapter.
    with tempfile.TemporaryDirectory(prefix='aihr-map-inventory-') as temporary:
        path = Path(temporary)/'logical-files.json'
        path.write_bytes(base.canonical(logical_manifest(manifest)))
        base.verify_directory(destination,path,runtime_source,producer_source,allow_runtime_cache=allow_runtime_cache)
    return manifest


if __name__=='__main__':
    try:
        mode,*args = sys.argv[1:]
        base.require((mode=='pack' and len(args)==2) or (mode=='unpack' and len(args)==4)
                     or (mode=='unpack-with-origin' and len(args)==5)
                     or (mode in {'verify-directory','verify-active-directory'} and len(args) in {3,4}),
                     'usage: build-map-bundle.py pack SOURCE OUTPUT | unpack ARCHIVE MANIFEST DESTINATION RUNTIME_SOURCE | '
                     'unpack-with-origin ARCHIVE MANIFEST DESTINATION RUNTIME_SOURCE PRODUCER_SOURCE | '
                     'verify-directory|verify-active-directory NEXT_DIRECTORY MANIFEST RUNTIME_SOURCE [PRODUCER_SOURCE]')
        result = pack(*args) if mode=='pack' else verify_directory(*args,allow_runtime_cache=mode=='verify-active-directory') if mode in {'verify-directory','verify-active-directory'} else unpack(*args)
        print(json.dumps({'format':result['format'],'capacityProfile':result['capacityProfile'],'kind':result['kind'],'files':len(result['files']),
                          'mapCopies':len(result['mapCopies']),'archiveBytes':result['archiveBytes'],
                          'unpackedBytes':result['unpackedBytes'],'releaseAuthorized':False,
                          **({'runtimeCacheExcluded':True} if mode=='verify-active-directory' else {})}))
    except (ValueError,OSError,KeyError,TypeError,json.JSONDecodeError,tarfile.TarError,EOFError) as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
