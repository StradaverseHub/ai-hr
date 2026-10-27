import importlib.util,json,os,pathlib,subprocess,tempfile,unittest
spec=importlib.util.spec_from_file_location('maintenance',pathlib.Path(__file__).resolve().parents[2]/'deploy/email-retention-maintenance.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class MaintenanceRefusalTests(unittest.TestCase):
 def test_private_url_literal_no_shell_execution(self):
  url='postgresql://user:literal$(do-not-run)@localhost/db?sslmode=verify-full'
  self.assertEqual(m.database_url('MIGRATION_DATABASE_URL='+json.dumps(url)),url)
  self.assertIn('PGDATABASE='+json.dumps(url),m.environment_bytes(url).decode())
 def test_duplicate_or_malformed_private_configuration_refused(self):
  for text in ['', 'MIGRATION_DATABASE_URL=http://example.test', 'MIGRATION_DATABASE_URL="unterminated', 'MIGRATION_DATABASE_URL=postgres://a\nMIGRATION_DATABASE_URL=postgres://b', 'MIGRATION_DATABASE_URL="postgres://x\\nsecret"']:
   with self.subTest(text=text),self.assertRaises(m.Refused):m.database_url(text)
 def test_symlink_group_writable_and_multiple_links_refused(self):
  with tempfile.TemporaryDirectory() as directory:
   p=pathlib.Path(directory)/'private';p.write_text('private');p.chmod(0o600)
   self.assertEqual(m.owned_regular(p,uid=os.getuid(),private=True),b'private')
   p.chmod(0o640)
   with self.assertRaises(m.Refused):m.owned_regular(p,uid=os.getuid(),private=True)
   p.chmod(0o600);link=pathlib.Path(directory)/'link';link.symlink_to(p)
   with self.assertRaises(m.Refused):m.owned_regular(link,uid=os.getuid())
   link.unlink();os.link(p,link)
   with self.assertRaises(m.Refused):m.owned_regular(p,uid=os.getuid())
 def test_finite_policy_or_record_changes_do_not_count_as_commissioned(self):
  before={'rows':504,'watermark':'1793109999999','days':None,'revision':0,'deliveries':7,'invitations':4,'lastRun':None,'lastDeleted':0}
  after={**before,'lastRun':'2026-10-27T16:00:00Z'};m.unchanged(before,after)
  for key,value in [('days',30),('revision',1),('deliveries',6),('invitations',3),('lastDeleted',1),('watermark','1793110000000')]:
   with self.subTest(key=key),self.assertRaises(m.Refused):m.unchanged(before,{**after,key:value})
 def test_service_executes_only_system_psql_fixed_sql(self):
  self.assertIn('ExecStart=/usr/bin/psql -X -qAt -v ON_ERROR_STOP=1 -c "select app.account_email_retention_prune()"',m.SERVICE)
  self.assertNotIn('/opt/ai-hr',m.SERVICE);self.assertNotIn('node',m.SERVICE);self.assertNotIn('bash',m.SERVICE)
  self.assertIn('User=aihr-maintenance',m.SERVICE);self.assertIn('ProtectSystem=strict',m.SERVICE)
 def test_exclusive_creation_never_overwrites_human_file(self):
  with tempfile.TemporaryDirectory() as directory:
   p=pathlib.Path(directory)/'unit';p.write_bytes(b'human')
   with self.assertRaises(FileExistsError):m.exclusive(p,b'replacement')
   self.assertEqual(p.read_bytes(),b'human')
 def test_nonroot_entry_refuses_before_any_mutation(self):
  if os.geteuid()==0:self.skipTest('Hosted controls run unprivileged')
  result=subprocess.run(['python3',str(pathlib.Path(m.__file__)),'install'],capture_output=True,text=True)
  self.assertEqual(result.returncode,1);self.assertTrue(json.loads(result.stdout)['maintenanceRefused'])
 def test_pgdatabase_uri_works_without_secret_in_argv(self):
  url=os.environ.get('RETENTION_TEST_DATABASE_URL')
  if not url:self.skipTest('Hosted disposable PostgreSQL fixture only')
  env={'PATH':'/usr/bin:/bin','PGDATABASE':url,'PGCONNECT_TIMEOUT':'10'}
  self.assertEqual(m.run(['/usr/bin/psql','-X','-qAt','-v','ON_ERROR_STOP=1','-c','select 1'],env),'1')
if __name__=='__main__':unittest.main()
