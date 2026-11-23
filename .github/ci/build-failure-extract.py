"""Extract the exact failed canonical build diagnostic namespace; never execute archive contents.

The build job's failure() upload holds exactly comparison.json plus the two GNU time command logs. Every other
member, directory, link, duplicate or oversized entry refuses.
"""
import pathlib,stat,sys,zipfile
MEMBERS={'comparison.json','canonical-build.log','application-typegen.log'}
archive,destination=map(pathlib.Path,sys.argv[1:])
destination.mkdir(mode=0o700)
with zipfile.ZipFile(archive) as z:
    entries=z.infolist()
    if len(entries)!=len(MEMBERS) or sum(i.file_size for i in entries)>32*1024*1024:
        raise ValueError('Build failure diagnostic exceeds evidence bounds')
    names=set()
    for i in entries:
        if i.is_dir() or '\\' in i.filename or pathlib.PurePosixPath(i.filename).name!=i.filename or i.filename not in MEMBERS or i.filename in names:
            raise ValueError('Unexpected build failure diagnostic member')
        if stat.S_ISLNK(i.external_attr>>16) or i.file_size>16*1024*1024:
            raise ValueError('Unsafe build failure diagnostic entry')
        names.add(i.filename)
        with (destination/i.filename).open('xb') as f:
            f.write(z.read(i))
    if names!=MEMBERS:
        raise ValueError('Incomplete build failure diagnostic')
