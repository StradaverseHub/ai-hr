"""Pure test adapter from the welcome-action course to the exact 9e9db history.

The existing historical controls still replay their original manifests in
full. Only the three reviewed current inputs enter this additional rewind.
"""

from hashlib import sha1, sha256


# Each row fixes the current SHA-256, original SHA-256 and Git blob, then the
# exact reverse line edits. The original tree is 9e9db2e5453663a627217513299b0e8307141a74.
_ROWS = {
    'scripts/performance/native-next-boot-browser.mjs': (
        '08730a5e9798540532a897a03a6dea83187a4dabd1650dc6a86a334cf510d62f',
        '89ed288238609baac6c476a56555ec70704de968271009edd40603e0d8e09063',
        '9b4b23ece16f8ad312bfc0e10665eaf56950a312',
        (
            (96, 134,
             (
                 b' const [finished,click]=await Promise.allSettled([\n'
                 b"  page.waitForEvent('requestfinished',{\n"
                 b'   predicate:request=>{\n'
                 b'    const url=new URL(request.url());\n'
                 b"    return url.origin===base&&url.pathname==='/'&&request.method()==='POST'&&Boolean(request.headers()['next-action']);\n"
                 b'   },\n'
                 b'   timeout:remaining(),\n'
                 b'  }),\n'
                 b'  skip.click({timeout:remaining()}),\n'
                 b' ]);\n'
             ),
             (
                 b' const matches=request=>{\n'
                 b'  const url=new URL(request.url());\n'
                 b"  return url.origin===base&&url.pathname==='/'&&request.method()==='POST'&&Boolean(request.headers()['next-action']);\n"
                 b' };\n'
                 b' // Diagnostics are independent of the existing completed-request assertion.\n'
                 b' // Track one matching Request object and emit only a bounded closed vocabulary.\n'
                 b' const note=(fact,statusClass=null)=>{\n'
                 b'  try{progress.action(fact,statusClass);}catch{/* Keep the original action outcome primary. */}\n'
                 b' };\n'
                 b' let firstPost;\n'
                 b' const listeners=[\n'
                 b"  ['request',request=>{\n"
                 b"   if(!firstPost&&matches(request)){firstPost=request;note('post-seen');}\n"
                 b'  }],\n'
                 b"  ['response',response=>{\n"
                 b"   if(firstPost&&response.request()===firstPost)note('post-response',Math.floor(response.status()/100));\n"
                 b'  }],\n'
                 b"  ['requestfailed',request=>{if(request===firstPost)note('post-failed');}],\n"
                 b"  ['requestfinished',request=>{if(request===firstPost)note('post-finished');}],\n"
                 b' ].map(([event,observe])=>[event,value=>{\n'
                 b'  try{observe(value);}catch{/* A diagnostic cannot interrupt a Playwright event. */}\n'
                 b' }]);\n'
                 b' let finished,click;\n'
                 b' try{\n'
                 b'  for(const [event,listener] of listeners)page.on(event,listener);\n'
                 b'  [finished,click]=await Promise.allSettled([\n'
                 b"   page.waitForEvent('requestfinished',{predicate:matches,timeout:remaining()}),\n"
                 b'   (async()=>{\n'
                 b"    note('click-entered');\n"
                 b'    try{\n'
                 b'     await skip.click({timeout:remaining()});\n'
                 b"     note('click-returned');\n"
                 b"    }catch(error){note('click-refused');throw error;}\n"
                 b'   })(),\n'
                 b'  ]);\n'
                 b' }finally{\n'
                 b'  for(const [event,listener] of listeners)page.off(event,listener);\n'
                 b' }\n'
             ),
            ),
            (63, 70,
             b'',
             (
                 b'  },\n'
                 b'  action(fact,statusClass=null){\n'
                 b"   assert(!finished&&stages[index]==='welcome-action'&&!actionFacts.has(fact)&&\n"
                 b"    ['click-entered','click-returned','click-refused','post-seen','post-response','post-failed','post-finished'].includes(fact));\n"
                 b"   assert(fact==='post-response'?Number.isInteger(statusClass)&&statusClass>=1&&statusClass<=5:statusClass===null);\n"
                 b'   actionFacts.add(fact);\n'
                 b"   emit({stage:'welcome-action',state:'observation',fact,...(fact==='post-response'?{statusClass}:{})});\n"
             ),
            ),
            (51, 52,
             b'',
             (
                 b' const actionFacts=new Set();\n'
             ),
            ),
        ),
    ),
    'deploy/admission/test_next_bootstrap_session.py': (
        '594bcaa697fc82b398f3b6af01df945d290cb88985f99823496b1b67f8fe7d33',
        '82fc2001f7d757d487fab2bcbd0bf68b886769d5ca7d53e131635f282958c1f6',
        'c6f393141ab85ca27700827e59d749760143bee3',
        (
            (479, 480,
             (
                 b"            data=(ROOT/path).read_bytes();self.assertEqual(hashlib.sha256(data).hexdigest(),row['currentSha256']);lines=data.decode().splitlines(keepends=True)\n"
             ),
             (
                 b"            data=pre_welcome_action_source(path,(ROOT/path).read_bytes());self.assertEqual(hashlib.sha256(data).hexdigest(),row['currentSha256']);lines=data.decode().splitlines(keepends=True)\n"
             ),
            ),
            (16, 17,
             b'',
             (
                 b'from next_boot_welcome_action_rewind import pre_welcome_action_source\n'
             ),
            ),
        ),
    ),
    'deploy/admission/test_controller_admit_timing.py': (
        'ac5ae66a3d87fe82e5f235f5064a1ba8dbf93618e553ff330b1b144ff999571e',
        '3701d28c8ff31d8d2a18cc4fcd8b990878758fe320846fb48066974814b52d0e',
        '267c9bc8b9c0ec07552280820a6741214482b5f2',
        (
            (347, 348,
             (
                 b"                data=(ROOT/name).read_bytes();self.assertEqual(hashlib.sha256(data).hexdigest(),row['currentSha256']);lines=data.decode().splitlines(keepends=True)\n"
             ),
             (
                 b"                data=pre_welcome_action_source(name,(ROOT/name).read_bytes());self.assertEqual(hashlib.sha256(data).hexdigest(),row['currentSha256']);lines=data.decode().splitlines(keepends=True)\n"
             ),
            ),
            (24, 26,
             b'',
             (
                 b"pre_welcome_action_source = load('admit_timing_boot_welcome_rewind',\n"
                 b"    ROOT/'deploy/admission/next_boot_welcome_action_rewind.py').pre_welcome_action_source\n"
             ),
            ),
        ),
    ),
}


def pre_welcome_action_source(path, current):
    row = _ROWS.get(path)
    if row is None:
        return current
    current_sha, original_sha, original_blob, changes = row
    if sha256(current).hexdigest() != current_sha:
        raise AssertionError('Welcome action rewind current bytes differ')
    lines = current.splitlines(keepends=True)
    frontier = len(lines)
    for start, end, before, after in changes:
        if not 0 <= start <= end <= frontier or b''.join(lines[start:end]) != after:
            raise AssertionError('Welcome action rewind edited span differs')
        lines[start:end] = before.splitlines(keepends=True)
        frontier = start
    restored = b''.join(lines)
    blob = sha1(b'blob ' + str(len(restored)).encode('ascii') + b'\0' + restored, usedforsecurity=False)
    if sha256(restored).hexdigest() != original_sha or blob.hexdigest() != original_blob:
        raise AssertionError('Welcome action rewind original bytes differ')
    return restored
