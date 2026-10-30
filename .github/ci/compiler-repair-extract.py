"""A focused packet may establish compiler source identity without contributing test coverage."""
import json,pathlib,re,stat,sys,zipfile
archive,destination=map(pathlib.Path,sys.argv[1:])
with zipfile.ZipFile(archive) as z:
    names=set();entries=z.infolist()
    if len(entries)>128 or sum(i.file_size for i in entries)>128*1024*1024:raise ValueError('Compiler packet exceeds bounds')
    for i in entries:
        allowed=i.filename in {'focused.json','nodb.vitest.json','db.vitest.json','postgres.log','postgres-state.json','postgres-stats.txt'} or re.fullmatch(r'ui-screenshots/[A-Za-z0-9_-]+\.(png|json)',i.filename)
        if not allowed or i.filename in names or i.is_dir() or stat.S_ISLNK(i.external_attr>>16) or i.flag_bits&1 or i.file_size>64*1024*1024:raise ValueError('Unsafe compiler packet member')
        names.add(i.filename)
    if 'focused.json' not in names:raise ValueError('Compiler source identity missing')
    r=json.loads(z.read('focused.json'));groups=r.get('groups',{})
    for group,result in [('NODB','nodb.vitest.json'),('DB','db.vitest.json')]:
        if bool(groups.get(group))!=(result in names):raise ValueError('Compiler packet process inventory differs')
    if not groups.get('DB') and not groups.get('NODB'):raise ValueError('Empty compiler source packet')
    destination.mkdir(mode=0o700)
    with (destination/'focused.json').open('xb') as out:out.write(z.read('focused.json'))
