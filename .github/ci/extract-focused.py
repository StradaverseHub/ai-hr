"""Extract only bounded focused JSON; retain authenticated ZIP containing other diagnostics."""
import json,pathlib,stat,sys,zipfile
archive,destination=map(pathlib.Path,sys.argv[1:]);destination.mkdir(mode=0o700)
wanted={'focused.json','nodb.vitest.json','db.vitest.json'}
with zipfile.ZipFile(archive) as z:
 entries=z.infolist()
 if len(entries)>10000 or sum(i.file_size for i in entries)>128*1024*1024:raise ValueError('Focused artifact exceeds bounds')
 seen=set()
 for i in entries:
  p=pathlib.PurePosixPath(i.filename)
  if '\\' in i.filename or p.is_absolute() or any(v in ('','..','.') for v in i.filename.rstrip('/').split('/')) or i.filename in seen:raise ValueError('Unsafe focused entry')
  seen.add(i.filename)
  if stat.S_ISLNK(i.external_attr>>16) or i.file_size>64*1024*1024:raise ValueError('Unsafe focused member')
  if i.filename in wanted:
   if i.is_dir():raise ValueError('Expected focused file')
   data=z.read(i);json.loads(data)
   with (destination/i.filename).open('xb') as f:f.write(data)
 if 'focused.json' not in seen:raise ValueError('Missing focused report')
