"""Pure synthetic Git Merkle controls; no Git, app, SQL or native host runs."""
import base64
import copy
import importlib.util
import pathlib
import unittest

SPEC = importlib.util.spec_from_file_location('native_next_source', pathlib.Path(__file__).with_name('next_source.py'))
S = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(S)


class Refused(RuntimeError):
    pass


def require(value, message):
    if not value:
        raise Refused(message)


def fixture(mode=b'100644', name=b'page.tsx'):
    body = b'/* known source */\n'
    blob = S.blob_id(body)
    leaf = mode + b' ' + name + b'\0' + bytes.fromhex(blob)
    leaf_id = S.object_id('tree', leaf)
    root = b'40000 app\0' + bytes.fromhex(leaf_id)
    root_id = S.object_id('tree', root)
    commit = b'tree ' + root_id.encode() + b'\nauthor Fixture <fiction@example.invalid> 0 +0000\ncommitter Fixture <fiction@example.invalid> 0 +0000\n\nKnown source\n'
    source = S.object_id('commit', commit)
    encode = lambda raw: base64.b64encode(raw).decode('ascii')
    proof = {'version': 1, 'source': source, 'commit': encode(commit),
             'trees': sorted([{'oid': leaf_id, 'bytes': encode(leaf)}, {'oid': root_id, 'bytes': encode(root)}], key=lambda item: item['oid'])}
    return source, proof, blob


class NativeSourceTests(unittest.TestCase):
    def test_recursive_file_identity_is_derived_from_exact_candidate_commit(self):
        source, proof, blob = fixture()
        self.assertEqual(S.verified_source(proof, source, require), [{'path': 'app/page.tsx', 'blob': blob, 'mode': 0o644}])
        self.assertNotEqual(blob, S.blob_id(b'/* changed source */\n'))
        source, proof, blob = fixture(mode=b'100755')
        self.assertEqual(S.verified_source(proof, source, require)[0]['mode'], 0o755)

    def test_head_or_manifest_claim_cannot_authorize_changed_objects(self):
        source, proof, _ = fixture()
        for change in ('source', 'commit', 'tree', 'missing', 'duplicate', 'foreign', 'unknown'):
            bad = copy.deepcopy(proof)
            if change == 'source':
                bad['source'] = 'a' * 40
            elif change == 'commit':
                bad['commit'] = base64.b64encode(b'tree ' + b'a' * 40 + b'\n').decode()
            elif change == 'tree':
                bad['trees'][0]['bytes'] = base64.b64encode(b'changed tree').decode()
            elif change == 'missing':
                bad['trees'].pop()
            elif change == 'duplicate':
                bad['trees'].append(bad['trees'][0])
            elif change == 'foreign':
                raw = b'100644 foreign\0' + bytes.fromhex('f' * 40)
                bad['trees'].append({'oid': S.object_id('tree', raw), 'bytes': base64.b64encode(raw).decode()})
                bad['trees'].sort(key=lambda item: item['oid'])
            else:
                bad['paths'] = [{'path': 'app/page.tsx', 'blob': 'f' * 40}]
            with self.subTest(change=change), self.assertRaises(Refused):
                S.verified_source(bad, source, require)

    def test_committed_traversal_links_submodules_and_malformed_records_refuse(self):
        for mode, name in ((b'100644', b'../secret'), (b'100644', b'.git'), (b'100644', b'a\\b'),
                           (b'120000', b'link'), (b'160000', b'submodule'), (b'100644', b'bad\nname')):
            source, proof, _ = fixture(mode=mode, name=name)
            with self.subTest(mode=mode, name=name), self.assertRaises(Refused):
                S.verified_source(proof, source, require)


if __name__ == '__main__':
    unittest.main()
