import sys
sys.dont_write_bytecode=True
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('broker',Path(__file__).resolve().parents[2]/'deploy/runner-control/broker.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
CATALOG=json.loads(Path(b.__file__).with_name('catalog.json').read_text())
class RunnerControlTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.policy={'environment':'staging','webUid':1234,'jobs':{'reviews':{'managed':True,'note':''}}}
        self.current={'revision':'a'*64,'managed':True,'installed':True,'hold':False,'running':False}
        self.request={'op':'configure','id':'reviews','actor':'11111111-1111-1111-1111-111111111111','revision':'a'*64,'enabled':False,'schedule':None}
    def tearDown(self): self.temp.cleanup()
    def test_production_holds_override_commissioned_policy(self):
        policy={**self.policy,'environment':'production'}
        for key in ['replacement-holidays','backups']:
            self.assertTrue(b.held(policy,key))
            request={**self.request,'id':key}
            with patch.object(b,'row_status',return_value={**self.current,'hold':True}),patch.object(b,'command') as command:
                with self.assertRaises(b.Refused):b.handle(request,policy,CATALOG)
                command.assert_not_called()
    def test_schedule_preserves_business_dates_and_explicit_timezone(self):
        for key,wanted in [('accrual','*-*-01'),('carry-expiry','*-04-01')]:
            row=next(row for row in CATALOG if row['id']==key)
            text=b.schedule(row,{'time':'03:15'})
            self.assertIn(wanted+' 03:15:00 Asia/Kuala_Lumpur',text)
            self.assertIn('Persistent=false',text)
    def test_refuses_schedule_and_command_injection(self):
        for value in [{'time':'03:00\nUser=root'},{'minutes':True},{'minutes':0},{'minutes':1441},{'command':'touch /tmp/x'}]:
            for row in [CATALOG[0],CATALOG[1]]:
                with self.assertRaises(b.Refused): b.schedule(row,value)
    def test_refuses_unknown_fields_and_jobs(self):
        for request in [{**self.request,'unit':'attacker.service'},{**self.request,'id':'../../x'},{**self.request,'enabled':'true'},{**self.request,'actor':'not-a-user'}]:
            with patch.object(b,'command') as command:
                with self.assertRaises(ValueError):b.handle(request,self.policy,CATALOG)
                command.assert_not_called()
    def test_stale_form_or_uncommissioned_job_cannot_mutate(self):
        for current in [{**self.current,'revision':'b'*64},{**self.current,'managed':False},{**self.current,'installed':False}]:
            with patch.object(b,'row_status',return_value=current),patch.object(b,'command') as command:
                with self.assertRaises(b.Refused):b.handle(self.request,self.policy,CATALOG)
                command.assert_not_called()
    def test_disable_timer_does_not_stop_inflight_hr_service(self):
        with patch.object(b,'row_status',return_value=self.current),patch.object(b,'STATE',self.root),patch.object(b,'command') as command:
            b.handle(self.request,self.policy,CATALOG)
            self.assertEqual([call.args for call in command.call_args_list],[('disable','aihr-review-sweep.timer'),('stop','aihr-review-sweep.timer')])
            audit=[json.loads(line) for line in (self.root/'audit.jsonl').read_text().splitlines()]
            self.assertEqual([row['outcome'] for row in audit],['requested','applied'])
            self.assertEqual(audit[0]['actor'],self.request['actor'])
    def test_failed_change_is_audited_without_a_false_applied_receipt(self):
        with patch.object(b,'row_status',return_value=self.current),patch.object(b,'STATE',self.root),patch.object(b,'command',side_effect=RuntimeError('private detail')):
            with self.assertRaises(b.Refused):b.handle(self.request,self.policy,CATALOG)
            audit=[json.loads(line) for line in (self.root/'audit.jsonl').read_text().splitlines()]
            self.assertEqual([row['outcome'] for row in audit],['requested','failed'])
            self.assertNotIn('private detail',(self.root/'audit.jsonl').read_text())
unittest.main()
