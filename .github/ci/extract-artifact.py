"""Extract bounded JSON-only evidence; never execute archive contents."""
import pathlib,stat,sys,zipfile
archive,destination=map(pathlib.Path,sys.argv[1:])
destination.mkdir(mode=0o700)
with zipfile.ZipFile(archive) as z:
    entries=z.infolist()
    if len(entries)>100 or sum(i.file_size for i in entries)>128*1024*1024:
        raise ValueError('Artifact exceeds evidence bounds')
    names=set()
    for i in entries:
        if i.is_dir():
            raise ValueError('Unexpected artifact directory')
        if '\\' in i.filename or pathlib.PurePosixPath(i.filename).name!=i.filename or not i.filename.endswith('.json') or i.filename in names:
            raise ValueError('Unsafe or duplicate artifact filename')
        if stat.S_ISLNK(i.external_attr>>16) or i.file_size>64*1024*1024:
            raise ValueError('Unsafe artifact entry')
        names.add(i.filename)
        with (destination/i.filename).open('xb') as f:
            f.write(z.read(i))
