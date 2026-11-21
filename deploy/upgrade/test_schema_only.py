"""Exercise the real shared queue and schema-only pickup on disposable state."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from coordinator import Coordinator

spec = importlib.util.spec_from_file_location('schema_only', Path(__file__).with_name('schema-only.py'))
schema = importlib.util.module_from_spec(spec)
spec.loader.exec_module(schema)


class PickupTests(unittest.TestCase):
    def test_pickup_waits_for_earlier_lease_and_retains_its_own_lease_on_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            packets = root / 'schema-only'
            packets.mkdir(mode=0o700)
            (root/'cutover.json').touch()
            engine = root/'upgrade-engine/deploy/upgrade/staging-index.mjs'
            engine.parent.mkdir(parents=True)
            engine.touch()
            old,new,build='a'*40,'b'*40,'build'
            probe=lambda:{'state':'ok','stale_build':'0','ref':old,'built_ref':old,
                          'build_id':build,'built_build_id':build,'backend':'canonical'}
            queue=Coordinator(root,probe=probe)
            self.addCleanup(queue.db.close)
            request=lambda action,**fields:schema.request(queue,action,**fields)
            def batch(candidate,migrations):
                key=str(uuid.uuid4())
                request('submit',spec={'id':key,'source':candidate,'base':old,'dependencies':[],
                    'risk':'isolated' if migrations else 'ordinary','migrations':migrations,
                    'acceptance':'read-only staging check','evidence':'fixture'})
                plan=request('prepare',tickets=[key],candidate=candidate,baseline=old,baselineBuild=build,
                    strategy='index-expansion' if migrations else None)
                return key,plan['batch']
            _,first=batch(old,[])
            key,second=batch(new,['fixture_index'])
            completed=packets/key
            completed.mkdir(mode=0o700)
            schema.record(completed/'batch.json',{'batch':second})
            schema.record(completed/'manifest.json',{'build':build})
            with patch.object(schema,'PACKETS',packets),patch.object(schema,'verify_manifest'),patch.object(schema,'install') as install:
                schema.pickup(queue,None)
                install.assert_not_called()
                lease=request('claim',batch=first)
                schema.pickup(queue,None)
                install.assert_not_called()
                request('abort',reason='Fixture lease handback',**lease)
                schema.pickup(queue,None)
                install.assert_called_once()
                ours=schema.read_record(completed/'lease.json')
                self.assertEqual(queue.lease(ours)[0]['batch'],second)
                schema.pickup(queue,None)
                self.assertEqual(install.call_count,2)
                self.assertEqual(install.call_args.args[-1],ours)

    def test_refuses_runtime_files_even_if_a_packet_is_submitted_directly(self):
        with self.assertRaisesRegex(ValueError, 'Runtime source changes'):
            schema.verify_manifest({'baseline':'a'*40,'candidate':'b'*40,'build':'ok','run':1,
                'tag':'one_index','smoke':'/route','sqlSha256':'c'*64,
                'files':{'db/migrations/one_index.sql':{},schema.JOURNAL:{},'next.config.ts':{}}})
