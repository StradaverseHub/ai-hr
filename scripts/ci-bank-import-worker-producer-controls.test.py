"""CI-only regression cases for explicit source pins and fresh ordinary source ledger binding."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('archive_gate',Path(__file__).with_name('ci-bank-import-worker-archive-runtime-smoke.py'))
gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)

class ProducerControls(unittest.TestCase):
    def test_required_immutable_pin(self):
        for value in (None,'','main','refs/heads/main','a'*39,'A'*40,'a'*41,'a'*40+'\n'):
            with self.subTest(value=value),self.assertRaises(RuntimeError):gate.source_pin(value)
        self.assertEqual(gate.source_pin('b'*40),'b'*40)

    def fixture(self,root,entries=None):
        migrations=root/'db/migrations';(migrations/'meta').mkdir(parents=True)
        entries=entries if entries is not None else [{'idx':4,'tag':'0004_first','when':100},{'idx':8,'tag':'0008_second','when':200}]
        (migrations/'meta/_journal.json').write_text(json.dumps({'entries':entries}))
        (migrations/'0004_first.sql').write_text('select 1;\n')
        (migrations/'0008_second.sql').write_text('select 2;\n')
        return migrations

    def test_actual_order_bytes_count_and_journal_are_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);migrations=self.fixture(root)
            expected=gate.ordinary_source_ledger(root)
            self.assertEqual(expected['rows'],2)
            gate.compare_ordinary_ledger(dict(expected),expected)
            for key,value in [('rows',1),('sha256','0'*64),('journalSha256','0'*64),('kind','STAGING')]:
                with self.subTest(key=key),self.assertRaises(RuntimeError):
                    gate.compare_ordinary_ledger({**expected,key:value},expected)
            (migrations/'0008_second.sql').write_text('select 3;\n')
            with self.assertRaises(RuntimeError):gate.compare_ordinary_ledger(gate.ordinary_source_ledger(root),expected)
            (migrations/'0008_second.sql').write_text('select 2;\n')
            journal=migrations/'meta/_journal.json';data=json.loads(journal.read_text())
            data['entries'].reverse();journal.write_text(json.dumps(data))
            with self.assertRaises(RuntimeError):gate.compare_ordinary_ledger(gate.ordinary_source_ledger(root),expected)
            data['entries'].pop();journal.write_text(json.dumps(data))
            with self.assertRaises(RuntimeError):gate.compare_ordinary_ledger(gate.ordinary_source_ledger(root),expected)

    def test_unsafe_missing_duplicate_and_invalid_source_entries_fail_closed(self):
        for entries in ([],[{'idx':0,'tag':'../escape','when':100}],
                        [{'idx':0,'tag':'absent','when':100}],
                        [{'idx':0,'tag':'0004_first','when':True}],
                        [{'idx':0,'tag':'0004_first','when':100}]*2,
                        [{'idx':0,'tag':'0004_first','when':100},{'idx':0,'tag':'0008_second','when':200}]):
            with self.subTest(entries=entries),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);self.fixture(root,entries)
                with self.assertRaises(RuntimeError):gate.ordinary_source_ledger(root)

    def test_sql_symlink_is_not_an_ordinary_source_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);migrations=self.fixture(root)
            (migrations/'0008_second.sql').unlink()
            (migrations/'0008_second.sql').symlink_to('0004_first.sql')
            with self.assertRaises(RuntimeError):gate.ordinary_source_ledger(root)

if __name__=='__main__':unittest.main()
