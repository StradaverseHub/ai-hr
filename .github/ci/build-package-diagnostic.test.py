"""The standalone read-only diagnostic must not mutate its controller checkout."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class ReadOnlyDiagnostic(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='aihr-package-diagnostic-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.controller = self.root/'controller'
        self.controller.mkdir()
        for name in ['build-package-diagnostic.py','build-bundle.py']:
            shutil.copyfile(Path(__file__).with_name(name),self.controller/name)
        self.source = self.root/'source'
        for name in ['fontkit','sharp']:
            package = self.source/'node_modules'/name
            package.mkdir(parents=True)
            (package/'package.json').write_text(json.dumps({'name':name,'version':'1.2.3'}))
            (package/'index.js').write_text('module.exports = 1;\n')
        self.before = {str(path.relative_to(self.controller)):path.read_bytes()
                       for path in self.controller.iterdir()}

    def run_diagnostic(self, *arguments):
        # Do not let the workflow's global -B equivalent hide a standalone bug.
        env = {key:value for key,value in os.environ.items()
               if key not in {'PYTHONDONTWRITEBYTECODE','PYTHONPYCACHEPREFIX'}}
        return subprocess.run([sys.executable,str(self.controller/'build-package-diagnostic.py'),
                               *map(str,arguments)],env=env,capture_output=True,text=True,timeout=20)

    def assert_controller_unchanged(self):
        self.assertEqual({str(path.relative_to(self.controller)) for path in self.controller.rglob('*')},
                         set(self.before))
        for name,data in self.before.items():
            self.assertEqual((self.controller/name).read_bytes(),data)

    def test_standalone_success_is_read_only_without_bytecode_environment_override(self):
        result = self.run_diagnostic(self.source,self.root/'original-producer')
        self.assertEqual(result.returncode,0,result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report['kind'],'read-only-package-relocation-comparison')
        self.assertFalse(report['releaseAuthorized'])
        self.assertEqual({row['package'] for row in report['packages']},{'fontkit','sharp'})
        self.assert_controller_unchanged()

    def test_argument_refusal_does_not_write_import_bytecode_either(self):
        result = self.run_diagnostic()
        self.assertNotEqual(result.returncode,0)
        self.assertIn('Usage:',result.stderr)
        self.assert_controller_unchanged()


if __name__=='__main__':
    unittest.main()
