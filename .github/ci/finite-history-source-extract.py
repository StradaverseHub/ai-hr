"""Read one bounded source identity, retaining the original authenticated ZIP without execution."""
import json,pathlib,re,stat,sys,zipfile
archive,member=sys.argv[1:]
if not re.fullmatch(r'(?:focused|ci-plan|unit-browser-(?:chromium|firefox|webkit))\.json',member):raise ValueError('Unknown source identity schema')
with zipfile.ZipFile(archive) as z:
    entries=z.infolist();names=[i.filename for i in entries]
    if len(entries)>128 or len(set(names))!=len(names) or member not in names or sum(i.file_size for i in entries)>128*1024*1024:raise ValueError('Unbounded or duplicate source packet')
    for i in entries:
        p=pathlib.PurePosixPath(i.filename)
        if '\\' in i.filename or p.is_absolute() or '..' in p.parts or i.is_dir() or stat.S_ISLNK(i.external_attr>>16) or i.flag_bits&1 or i.file_size>64*1024*1024:raise ValueError('Unsafe source packet member')
    print(json.dumps(json.loads(z.read(member))))
