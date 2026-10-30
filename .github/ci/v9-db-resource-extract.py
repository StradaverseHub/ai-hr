"""Finite DB diagnostic packet only. Preserve the original ZIP and extract no executables."""
import pathlib,stat,sys,zipfile
archive,destination=map(pathlib.Path,sys.argv[1:])
required={'focused.json','db.vitest.json','postgres-state.json','postgres-stats.txt','postgres.log'}
with zipfile.ZipFile(archive) as z:
    entries=z.infolist()
    if len(entries)!=len(required) or {i.filename for i in entries}!=required or sum(i.file_size for i in entries)>128*1024*1024:
        raise ValueError('Exact bounded DB packet required')
    for i in entries:
        if i.is_dir() or stat.S_ISLNK(i.external_attr>>16) or i.flag_bits&1 or i.file_size>64*1024*1024:
            raise ValueError('Unsafe DB packet member')
    destination.mkdir(mode=0o700)
    for name in sorted(required):
        with (destination/name).open('xb') as out:out.write(z.read(name))
