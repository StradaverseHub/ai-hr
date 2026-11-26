"""Extract the bounded `next-application-build-failure` namespace; never execute archive contents.

The build job's failure() upload holds comparison.json plus the GNU time command logs that existed when it failed
(canonical-build.log, application-typegen.log). comparison.json is required; each log is optional and bounded.
Routes that need both logs (aihr-build-capacity-recovery/v1) require them themselves. Every other member, directory,
link, encrypted, duplicate or oversized entry refuses, and nothing is written until every entry has been checked.
"""
import pathlib,stat,sys,zipfile
REQUIRED='comparison.json'
LOGS={'canonical-build.log','application-typegen.log'}
if len(sys.argv)!=3:
    raise SystemExit('usage: build-failure-extract.py ARCHIVE DESTINATION')
archive,destination=map(pathlib.Path,sys.argv[1:])
with zipfile.ZipFile(archive) as z:
    entries=z.infolist()
    if not 1<=len(entries)<=1+len(LOGS) or sum(i.file_size for i in entries)>32*1024*1024:
        raise ValueError('Build failure diagnostic exceeds evidence bounds')
    names=set()
    for i in entries:
        if i.is_dir() or '\\' in i.filename or pathlib.PurePosixPath(i.filename).name!=i.filename or (i.filename!=REQUIRED and i.filename not in LOGS) or i.filename in names:
            raise ValueError('Unexpected build failure diagnostic member')
        if stat.S_ISLNK(i.external_attr>>16) or i.flag_bits&1 or i.file_size>16*1024*1024:
            raise ValueError('Unsafe build failure diagnostic entry')
        names.add(i.filename)
    if REQUIRED not in names:
        raise ValueError('Build failure comparison.json missing')
    destination.mkdir(mode=0o700)
    for i in entries:
        with (destination/i.filename).open('xb') as f:
            f.write(z.read(i))
