"""Read one bounded source-binding JSON member; never execute or extract other payloads."""
import json,pathlib,re,stat,sys,zipfile
archive=pathlib.Path(sys.argv[1]);member=sys.argv[2]
if not re.fullmatch(r'(?:focused|ci-plan|unit-browser-(?:chromium|firefox|webkit))\.json',member):raise ValueError('Unknown source binding')
with zipfile.ZipFile(archive) as z:
    entries=z.infolist();names=[i.filename for i in entries]
    if len(entries)>128 or len(set(names))!=len(names) or member not in names or sum(i.file_size for i in entries)>128*1024*1024:raise ValueError('Unbounded/duplicate packet')
    for i in entries:
        p=pathlib.PurePosixPath(i.filename)
        if p.is_absolute() or '..' in p.parts or i.is_dir() or stat.S_ISLNK(i.external_attr>>16) or i.flag_bits&1 or i.file_size>64*1024*1024:raise ValueError('Unsafe source packet')
    print(json.dumps(json.loads(z.read(member))))
