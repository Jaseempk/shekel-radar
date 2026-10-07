import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from lib.opportunities import QualificationStore

ROOT = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RedditStateTests(unittest.TestCase):
    def test_error_checkpoint_is_retryable_and_results_survive_restart(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp); old = base/'checkpoint.jsonl'; db = base/'state.sqlite'
            failed = {'url':'https://reddit.com/r/test/comments/abc','buyer_reason':'error: timeout','buyer_score':0,'is_buyer':False,'draft':''}
            old.write_text(json.dumps(failed)+'\n')
            store=QualificationStore(db); store.import_legacy('reddit:buyers',old)
            self.assertEqual(len(store.pending('reddit:buyers')),1)
            result={**failed,'is_buyer':True,'buyer_score':80,'buyer_reason':'Needs help','draft':'A useful reply'}
            store.complete('reddit:buyers',result); store.close()
            store=QualificationStore(db); store.import_legacy('reddit:buyers',old)
            self.assertFalse(store.pending('reddit:buyers'))
            self.assertEqual(store.results('reddit:buyers')[0]['buyer_score'],80)
            store.close()

    def test_bad_boolean_does_not_complete_lead(self):
        with tempfile.TemporaryDirectory() as temp:
            store=QualificationStore(Path(temp)/'db.sqlite')
            row={'url':'https://reddit.com/example','is_buyer':'false','buyer_score':10,'buyer_reason':'No','draft':''}
            store.ingest('reddit:buyers',[row])
            with self.assertRaises(ValueError): store.complete('reddit:buyers',row)
            self.assertEqual(len(store.pending('reddit:buyers')),1)
            store.close()

    def test_export_is_beside_requested_output_and_needs_no_model(self):
        module=load('draft_leads_test',ROOT/'reddit-mining/draft_leads.py')
        with tempfile.TemporaryDirectory() as temp:
            target=Path(temp)/'nested'/'queue.csv'
            count,_,md=module.write_outputs([{'is_buyer':True,'buyer_score':80,'draft':'Helpful reply','url':'https://example.com'}],str(target),55)
            self.assertEqual(count,1)
            self.assertEqual(Path(md),target.with_suffix('.md'))
            self.assertTrue(target.with_suffix('.json').exists())
