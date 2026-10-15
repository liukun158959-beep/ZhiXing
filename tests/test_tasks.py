"""真实子进程验证：硬超时、取消、并行及会话顺序。不调用线上模型。"""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from desk_companion.tasks import TaskManager

WORKER = '''import json,sys,time
r=json.loads(sys.stdin.readline())
def emit(k,d):
 print(json.dumps(dict(kind=k,data=d)),flush=True)
emit('token','保留片段')
if r['text']=='timeout':
 emit('llm_start',{})
 time.sleep(10)
elif r['text']=='slow': time.sleep(.7)
elif r['text']=='stream':
 emit('llm_start',{})
 for i in range(7):
  time.sleep(.07)
  emit('token','流')
 emit('llm_end',{})
elif r['text']=='stream_stalls':
 emit('llm_start',{})
 emit('token','流')
 time.sleep(10)
elif r['text']=='archive_timeout':
 emit('result','完整笔记')
 emit('tool_start',dict(tool='archive_video_notes',read_only=False))
 time.sleep(10)
elif r['text']=='tool':
 emit('tool_start',dict(tool='create_calendar_event',step='s1'))
 emit('tool_end',dict(tool='create_calendar_event',step='s1',status='success'))
elif r['text']=='video_failure':
 emit('failure',dict(type='APIConnectionError',message='片段 3/8 连接中断，已完成2/8',phase='片段3',completed=2,total=8))
 sys.exit(0)
emit('result',r['text'])
'''


class TaskTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"DESK_COMPANION_DATA_DIR": self.temp.name})
        self.env.start()
        self.worker = Path(self.temp.name) / "worker.py"
        self.worker.write_text(WORKER, "utf-8")
        self.manager = TaskManager(path=Path(self.temp.name) / "tasks.sqlite3", command=[sys.executable, "-u", str(self.worker)])

    def tearDown(self):
        self.manager.shutdown()
        deadline = time.time() + 5
        while self.manager.active and time.time() < deadline:
            time.sleep(.05)
        self.env.stop()
        self.temp.cleanup()

    def test_parallel_and_same_session_fifo(self):
        first = self.manager.submit("slow", "a")
        second = self.manager.submit("second", "a")
        other = self.manager.submit("other", "b")
        self.assertEqual(self.manager.wait(other)["answer"], "other")
        self.assertNotIn(self.manager.get(first)["state"], {"succeeded", "failed"})
        self.assertEqual(self.manager.get(second)["state"], "queued")
        a = self.manager.wait(first)
        b = self.manager.wait(second)
        self.assertGreaterEqual(b["started"], a["ended"])

    def test_stable_submission_key_never_starts_the_same_work_twice(self):
        first = self.manager.submit("slow", "stable-session", "collaboration", submission_key="stable-key")
        second = self.manager.submit("slow", "stable-session", "collaboration", submission_key="stable-key")
        self.assertEqual(first, second)
        with self.assertRaises(ValueError):
            self.manager.submit("different", "stable-session", "collaboration", submission_key="stable-key")
        self.manager.wait(first)
        self.assertEqual(len(self.manager.list()["items"]), 1)

    def test_hard_call_timeout_keeps_partial(self):
        self.manager.settings.update(call_timeout=.2, task_timeout=3)
        started = time.monotonic()
        task = self.manager.wait(self.manager.submit("timeout", "a"))
        self.assertEqual(task["state"], "timed_out")
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(task["answer"], "保留片段")

    def test_video_failure_preserves_phase_and_coverage_in_timeline(self):
        task = self.manager.wait(self.manager.submit("video_failure", "a"))
        self.assertEqual(task["state"], "failed")
        self.assertIn("连接中断", task["error"])
        event = next(e for e in task["events"] if e["kind"] == "failure")
        self.assertEqual((event["data"]["completed"], event["data"]["total"]), (2, 8))
        self.assertEqual(event["data"]["phase"], "片段3")

    def test_archive_timeout_preserves_finished_answer(self):
        self.manager.settings.update(call_timeout=.3, task_timeout=3)
        task = self.manager.wait(self.manager.submit("archive_timeout", "a"))
        self.assertEqual(task["state"], "succeeded")
        self.assertEqual(task["answer"], "完整笔记")
        self.assertIn("归档达到时限", task["error"])

    def test_streaming_progress_extends_idle_deadline_but_stalls_still_timeout(self):
        self.manager.settings.update(call_timeout=.2, task_timeout=3)
        task = self.manager.wait(self.manager.submit("stream", "a"))
        self.assertEqual(task["state"], "succeeded")
        stalled = self.manager.wait(self.manager.submit("stream_stalls", "a"))
        self.assertEqual(stalled["state"], "timed_out")
        self.assertIn("流", stalled["answer"])

    def test_streaming_cannot_extend_total_task_deadline(self):
        self.manager.settings.update(call_timeout=.2, task_timeout=.3)
        task = self.manager.wait(self.manager.submit("stream", "a"))
        self.assertEqual(task["state"], "timed_out")

    def test_single_video_link_routes_from_feishu_and_successful_followup_uses_agent(self):
        task_id = self.manager.submit("https://www.bilibili.com/video/BV1ojfDBSEPv", "a", "feishu")
        task = self.manager.wait(task_id)
        with self.manager.db() as db:
            request = json.loads(db.execute("SELECT request FROM tasks WHERE id=?", (task_id,)).fetchone()[0])
        self.assertEqual(request["workflow"], "video_note")
        self.assertEqual(request["limits"]["task_timeout"], 900)
        self.assertEqual(task["source"]["workflow"], "video")
        next_id = self.manager.resume(task_id, "只解释一个词")
        self.manager.wait(next_id)
        with self.manager.db() as db:
            followup = json.loads(db.execute("SELECT request FROM tasks WHERE id=?", (next_id,)).fetchone()[0])
        self.assertNotIn("workflow", followup)
        self.assertFalse(followup["auto_video_archive"])

    def test_archive_config_snapshot_and_successful_followup_opt_out(self):
        from desk_companion.wiki_connection import settings_path
        from desk_companion.video import atomic_write
        atomic_write(settings_path(), {"auto_video_save": True, "video_parent_token": "video"})
        task = self.manager.wait(self.manager.submit("normal", "a"))
        atomic_write(settings_path(), {"auto_video_save": False})
        resumed = self.manager.resume(task["id"], "详细说说一个概念")
        with self.manager.db() as db:
            request = json.loads(db.execute("SELECT request FROM tasks WHERE id=?", (resumed,)).fetchone()[0])
        self.assertTrue(request["video_archive_config"]["auto_video_save"])
        self.assertFalse(request["auto_video_archive"])
        self.manager.wait(resumed)

    def test_cancel_running_and_queued(self):
        first = self.manager.submit("timeout", "a")
        second = self.manager.submit("next", "a")
        deadline = time.time() + 2
        while not self.manager.get(first)["answer"] and time.time() < deadline:
            time.sleep(.02)
        self.manager.cancel(second)
        self.manager.cancel(first)
        self.assertEqual(self.manager.wait(first)["state"], "cancelled")
        self.assertEqual(self.manager.wait(second)["state"], "cancelled")

    def test_restart_never_replays_and_resume_carries_steps(self):
        task = self.manager.wait(self.manager.submit("tool", "a"))
        resumed = self.manager.resume(task["id"], "请继续")
        with self.manager.db() as db:
            payload = json.loads(db.execute("SELECT request FROM tasks WHERE id=?", (resumed,)).fetchone()[0])
        self.assertIn("create_calendar_event", payload["resume_note"])
        self.assertIn("不可盲目重做", payload["resume_note"])
        self.manager.wait(resumed)
        with self.manager.db() as db:
            db.execute("UPDATE tasks SET state='running' WHERE id=?", (task["id"],))
            db.commit()
        self.manager.shutdown()
        self.manager.scheduler.join(1)
        self.manager = TaskManager(path=self.manager.path, command=[sys.executable, "-u", str(self.worker)])
        self.assertEqual(self.manager.get(task["id"])["state"], "interrupted")


if __name__ == "__main__":
    unittest.main()
