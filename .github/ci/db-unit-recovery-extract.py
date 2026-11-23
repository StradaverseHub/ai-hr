"""aihr-db-unit-recovery/v1 packet: extract only focused.json + db.vitest.json; bounded diagnostics stay in the authenticated ZIP."""
import json,pathlib,re,stat,sys,zipfile
archive,destination=map(pathlib.Path,sys.argv[1:])
RESULTS={'focused.json','db.vitest.json'}
POSTGRES={'postgres.log','postgres-state.json','postgres-stats.txt'}
# Diagnostics written by the focused DB runner and visual tests; never parsed, never extracted.
DIAGNOSTIC=re.compile(r'(?:[A-Za-z0-9][A-Za-z0-9_-]{0,120}\.(?:png|json|log|txt)|operational-preview-heap/heap-[0-9]{1,10}\.json|ui-screenshots/[A-Za-z0-9_-]+\.(?:png|json))')
with zipfile.ZipFile(archive) as z:
    entries=z.infolist()
    if len(entries)>512 or sum(i.file_size for i in entries)>128*1024*1024:
        raise ValueError('DB-unit packet exceeds bounds')
    names=set()
    for i in entries:
        allowed=i.filename in RESULTS or i.filename in POSTGRES or (i.filename!='nodb.vitest.json' and DIAGNOSTIC.fullmatch(i.filename))
        if not allowed or i.filename in names or i.is_dir() or stat.S_ISLNK(i.external_attr>>16) or i.flag_bits&1:
            raise ValueError('Unsafe, duplicate or unknown DB-unit packet member')
        if i.file_size>(64*1024*1024 if i.filename in RESULTS else 16*1024*1024):
            raise ValueError('DB-unit packet member exceeds bound')
        names.add(i.filename)
    if not RESULTS.issubset(names) or not POSTGRES.issubset(names):
        raise ValueError('DB result or database diagnostics missing')
    groups=json.loads(z.read('focused.json')).get('groups',{})
    if not groups.get('DB') or groups.get('NODB'):
        raise ValueError('One homogeneous DB partition required')
    destination.mkdir(mode=0o700)
    for name in sorted(RESULTS):
        with (destination/name).open('xb') as out:out.write(z.read(name))
