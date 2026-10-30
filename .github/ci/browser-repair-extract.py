"""Bounded original browser archives; preserve ZIPs, expose only authenticated data to JS."""
import json,pathlib,re,stat,sys,zipfile
archive,destination,mode,engine=sys.argv[1:]
if mode not in {'unit','identity'} or engine not in {'chromium','firefox','webkit'}:raise ValueError('Unknown browser packet mode')
with zipfile.ZipFile(archive) as z:
    entries=z.infolist();names=set()
    if len(entries)>128 or sum(i.file_size for i in entries)>128*1024*1024:raise ValueError('Browser packet exceeds bounds')
    required={f'unit-browser-{engine}.json',f'browser-{engine}-batch-0.json',f'health-before-browser-{engine}.json'} if mode=='unit' else {'filesystem-capacity.txt','image-binding.json','installed-packages.tsv','lockfile-sha256.txt','source-sha.txt'}
    for i in entries:
        diagnostic=mode=='unit' and re.fullmatch(r'ui-screenshots/[A-Za-z0-9_-]+\.(png|json)',i.filename)
        if i.filename not in required and not diagnostic or i.filename in names or i.is_dir() or stat.S_ISLNK(i.external_attr>>16) or i.flag_bits&1:raise ValueError('Unsafe, duplicate or unknown browser member')
        if i.file_size>64*1024*1024:raise ValueError('Browser member exceeds bound')
        names.add(i.filename)
    if not required.issubset(names):raise ValueError('Missing browser identity or complete unit result')
    destination=pathlib.Path(destination);destination.mkdir(mode=0o700)
    if mode=='unit':
        for name in sorted(required):
            with (destination/name).open('xb') as out:out.write(z.read(name))
    else:
        with (destination/'image-binding.json').open('xb') as out:out.write(z.read('image-binding.json'))
        with (destination/'source-binding.json').open('x') as out:json.dump({'sourceText':z.read('source-sha.txt').decode('utf8'),'lockText':z.read('lockfile-sha256.txt').decode('utf8')},out)
