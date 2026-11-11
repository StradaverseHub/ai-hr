"""Import footprint checks in a private Git fixture, with the actual caller's Python settings."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

class HelperCleanliness(unittest.TestCase):
    def test_readers_leave_their_frozen_controller_clean(self):
        for reader in ["build-transport-extract.py","build-package-diagnostic.py"]:
            with self.subTest(reader=reader),tempfile.TemporaryDirectory(prefix="aihr-helper-clean-",dir="/private/tmp" if Path("/private/tmp").is_dir() else None) as temp:
                root=Path(temp).resolve();directory=root/".github/ci";directory.mkdir(parents=True)
                for name in ["build-bundle.py",reader]:
                    (directory/name).write_bytes(Path(__file__).with_name(name).read_bytes())
                environment={**os.environ,"GIT_CONFIG_GLOBAL":os.devnull,"GIT_CONFIG_NOSYSTEM":"1"}
                def git(*args):
                    return subprocess.check_output(["git","-C",str(root),*args],env=environment,text=True).strip()
                git("init","-q");git("add",".")
                git("-c","user.name=Private fixture","-c","user.email=fixture@example.invalid","commit","-qm","Owned helper fixture")
                self.assertEqual(git("status","--porcelain","--untracked-files=all"),"")
                result=subprocess.run(["python3",str(directory/reader)],cwd=root,env=environment,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
                self.assertEqual(result.returncode,1);self.assertIn("Usage:",result.stdout)
                self.assertEqual(git("status","--porcelain","--untracked-files=all"),"",reader+" polluted the frozen controller")
if __name__=="__main__":unittest.main()
