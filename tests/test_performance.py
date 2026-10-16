import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from desk_companion.performance import HttpTiming,percentile,summarize,task_timing,task_snapshot


class PerformanceTests(unittest.TestCase):
    def test_nearest_rank_and_sample_guard_and_failure_denominator(self):
        self.assertEqual(percentile(range(1,101),.99),99)
        samples=[dict(state='succeeded',duration_ms=i,first_text_ms=i/2) for i in range(1,100)]
        self.assertIsNone(summarize(samples)['duration_ms']['p99'])
        samples.append(dict(state='timed_out',duration_ms=40000,error='Timeout'))
        value=summarize(samples)
        self.assertEqual(value['duration_ms']['p99'],99)
        self.assertEqual(value['duration_ms']['max'],40000)
        self.assertEqual(value['failed'],1);self.assertEqual(value['timeouts'],1);self.assertEqual(value['failure_rate'],.01)
        self.assertIsNone(value['first_text_ms']['p99'])
        self.assertIsNone(summarize([])['failure_rate'])

    def test_trace_records_only_numeric_stages_with_pending_time_and_marks(self):
        now=[10.0];timing=HttpTiming(lambda:now[0])
        timing.trace('connection.connect_tcp.started',{'secret':'PRIVATE'})
        now[0]=10.1;timing.trace('connection.connect_tcp.complete',{})
        timing.trace('connection.start_tls.started',{})
        now[0]=10.4;timing.mark('first_text');timing.mark('first_text')
        result=timing.payload()
        self.assertAlmostEqual(result['spans'][0]['duration_ms'],100)
        self.assertAlmostEqual(result['spans'][1]['duration_ms'],300)
        self.assertEqual(result['spans'][1]['state'],'incomplete')
        self.assertNotIn('PRIVATE',json.dumps(result))

    def test_task_chain_is_nonoverlapping_and_includes_tools_and_queue(self):
        task=dict(state='succeeded',created=1,started=2,ended=10,events=[
            dict(kind='llm_start',ts=3,data={}),dict(kind='llm_end',ts=6,data={}),
            dict(kind='tool_start',ts=6.5,data={'tool':'web_search'}),dict(kind='tool_end',ts=8,data={}),
            dict(kind='llm_start',ts=8.5,data={}),dict(kind='llm_end',ts=9.5,data={})])
        result=task_timing(task)
        self.assertEqual(sum(s['duration_ms'] for s in result['stages']),9000)
        self.assertEqual(result['longest']['label'],'模型调用 1')
        task.update(state='timed_out',ended=0);task['events']=task['events'][:1]
        result=task_timing(task,now=5)
        self.assertEqual(result['stages'][-1]['duration_ms'],2000)

    def test_task_lookup_reads_collaboration_queue_without_starting_manager(self):
        with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{'DESK_COMPANION_DATA_DIR':folder}):
            path=Path(folder)/'memory/collaboration/chat/tasks.sqlite3';path.parent.mkdir(parents=True)
            ident='a'*32
            db=sqlite3.connect(path)
            try:
                db.execute('CREATE TABLE tasks(id TEXT,state TEXT,text TEXT,answer TEXT,error TEXT,created REAL,started REAL,ended REAL)')
                db.execute('CREATE TABLE events(seq INTEGER,task TEXT,kind TEXT,data TEXT,ts REAL)')
                db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)',(ident,'running','hello','','',1,2,0));db.commit()
            finally:db.close()
            self.assertEqual(task_snapshot(ident)['state'],'running')
            self.assertFalse((Path(folder)/'memory/tasks.sqlite3').exists())
            self.assertIsNone(task_snapshot('../bad'))


if __name__=='__main__':unittest.main()
