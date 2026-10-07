import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('prune_data',ROOT/'tools/prune-data.py')
prune=importlib.util.module_from_spec(spec);spec.loader.exec_module(prune)


class RetentionTests(unittest.TestCase):
    def test_pruning_only_targets_disposable_data_and_ignores_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            for rel in ['data/raw/old.json','exports/old.json','state/history.sqlite','source.py']:
                p=root/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('important');os.utime(p,(0,0))
            (root/'data/raw/link').symlink_to(root/'source.py')
            selected=prune.candidates(root,30,90,1024,now=100*86400)
            self.assertEqual(set(p.relative_to(root).as_posix() for p in selected),{'data/raw/old.json','exports/old.json'})
            self.assertTrue((root/'data/raw/old.json').exists())

    def test_raw_size_budget_removes_oldest_first(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder=root/'data/raw';folder.mkdir(parents=True)
            for n in range(3):
                p=folder/str(n);p.write_bytes(b'x'*1024*1024);os.utime(p,(100+n,100+n))
            chosen=prune.candidates(root,30,90,1,now=200)
            self.assertEqual({p.name for p in chosen},{'0','1'})
