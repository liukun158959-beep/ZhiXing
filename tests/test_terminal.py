"""Sandbox policy, command lifecycle and UI/Agent shared ownership. No LLM or personal data."""
import base64
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

from desk_companion import terminal


class TerminalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"DESK_COMPANION_DATA_DIR": self.temp.name})
        self.env.start()
        self.manager = terminal.TerminalManager()

    def tearDown(self):
        self.manager.shutdown()
        self.env.stop()
        self.temp.cleanup()

    def test_missing_sandbox_fails_closed_and_never_starts_a_host_command(self):
        with patch.object(self.manager, "status", return_value={"ready": False, "error": "未连接"}), patch("subprocess.Popen") as popen:
            with self.assertRaisesRegex(RuntimeError, "未连接"):
                self.manager.start("echo unsafe", request_id=uuid.uuid4().hex)
            popen.assert_not_called()

    def test_validation_and_paths_do_not_accept_host_paths_or_control_options(self):
        for values in [dict(cwd="C:/Users"), dict(cwd="/workspace/../etc"), dict(timeout=True), dict(timeout=301), dict(owner="host")]:
            with self.assertRaises(ValueError):
                self.manager.start("echo ok", request_id=uuid.uuid4().hex, **values)
        with self.assertRaises(ValueError):
            terminal.distro_name("--exec")
        with self.assertRaises(ValueError):
            terminal.inside(Path(self.temp.name) / "../outside", self.temp.name)
        self.assertNotEqual(terminal.workspace("a"), terminal.workspace("b"))

    def test_finished_task_rejects_late_start_even_after_sandbox_probe(self):
        self.manager.cancel_task("task1")
        with patch.object(self.manager, "status", return_value={"ready": True, "distro": "Ubuntu"}):
            with self.assertRaisesRegex(RuntimeError, "任务已结束"):
                self.manager.start("echo ok", task_id="task1", request_id=uuid.uuid4().hex)

    def test_record_restart_is_interrupted_and_output_is_paginated_by_bytes(self):
        ident = uuid.uuid4().hex
        directory = terminal.root() / "jobs" / ident; directory.mkdir(parents=True)
        job = dict(id=ident, state="running", session="s", created=1, output_bytes=100000)
        (directory / "meta.json").write_text(json.dumps(job))
        data = ("中文\n" * 20000).encode()
        (directory / "output.bin").write_bytes(data)
        value = self.manager.read(ident)
        self.assertEqual(value["job"]["state"], "interrupted")
        self.assertEqual(len(base64.b64decode(value["data"])), 65536)
        remaining = self.manager.read(ident, value["offset"])
        self.assertEqual(base64.b64decode(value["data"]) + base64.b64decode(remaining["data"]) + base64.b64decode(self.manager.read(ident, remaining["offset"])["data"]), data)

    def test_active_worker_command_is_visible_and_cancellable_from_another_manager(self):
        ident=uuid.uuid4().hex
        folder=terminal.root()/'jobs'/ident;folder.mkdir(parents=True)
        job=dict(id=ident,state='running',session='project:fixture',created=1,output_bytes=0,task_id='coding-one')
        (folder/'meta.json').write_text(json.dumps(job));(folder/'lease').touch();(folder/'output.bin').touch()
        self.assertEqual(self.manager.get(ident)['state'],'running')
        self.assertEqual(self.manager.list()['jobs'][0]['state'],'running')
        self.manager.cancel_task('coding-one')
        self.assertTrue((folder/'stop').exists())
        self.assertEqual(self.manager.get(ident)['state'],'stopping')

    def test_retry_receipt_does_not_reexecute_a_job_outside_recent_history(self):
        ident, request_id = uuid.uuid4().hex, uuid.uuid4().hex
        directory = terminal.root() / "jobs" / ident; directory.mkdir(parents=True)
        (directory / "meta.json").write_text(json.dumps(dict(id=ident, state="succeeded", session="s", created=1)))
        receipts = terminal.root() / "requests"; receipts.mkdir()
        (receipts / request_id).write_text(ident)
        with patch.object(self.manager, "status", return_value={"ready": True}), patch.object(self.manager, "list", return_value={"jobs": []}), patch("subprocess.Popen") as popen:
            value = self.manager.start("echo should-not-run", request_id=request_id)
            self.assertEqual(value["job"]["id"], ident)
            popen.assert_not_called()

    def test_attachment_import_copies_original_without_overwrite_and_previews_snapshot(self):
        original = Path(self.temp.name) / "source.md"; original.write_text("# 原文", "utf-8")
        from desk_companion.local_sources import stage
        source = stage([str(original)], "file")["sources"][0]
        value = self.manager.import_files("s", [source["id"]])
        self.assertEqual(len(value["files"]), 1)
        copied = terminal.workspace("s") / value["files"][0]
        copied.write_text("# 修改后", "utf-8")
        self.assertEqual(original.read_text("utf-8"), "# 原文")
        self.assertTrue(self.manager.preview_file("s", value["files"][0])["sources"])
        with self.assertRaises(ValueError):
            self.manager.preview_file("s", "../source.md")


    def test_folder_import_preserves_relative_structure_and_file_names(self):
        from desk_companion.local_sources import stage
        directory = Path(self.temp.name) / "project" / "sub"
        directory.mkdir(parents=True)
        (directory / "notes.md").write_text("nested", "utf-8")
        source = stage([str(directory.parent)], "folder")["sources"][0]
        value = self.manager.import_files("s", [source["id"]])
        self.assertTrue(value["files"][0].endswith("/1-project/sub/notes.md"))
        self.assertEqual((terminal.workspace("s") / value["files"][0]).read_text("utf-8"), "nested")


@unittest.skipUnless(os.environ.get("DESK_TEST_SANDBOX") == "1", "Set DESK_TEST_SANDBOX=1 to exercise the installed sandbox")
class RealSandboxTests(TerminalTests):
    def setUp(self):
        super().setUp()
        value = self.manager.status(refresh=True)
        self.assertTrue(value["ready"], value["error"])

    def start(self, command, **args):
        return self.manager.start(command, session="s", request_id=uuid.uuid4().hex, **args)["job"]

    def wait(self, job, state=None, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = self.manager.get(job["id"])
            if (state and value["state"] == state) or (state is None and value["state"] not in terminal.ACTIVE):
                return value
            time.sleep(.05)
        self.fail("Command did not reach expected state: " + repr(value))

    def output(self, job):
        return base64.b64decode(self.manager.read(job["id"])["data"]).decode("utf-8", "replace")

    def test_real_isolation_and_output_cannot_forge_events(self):
        script = '''import os, pathlib, socket
assert not pathlib.Path('/mnt/c').exists()
assert not pathlib.Path('/init').exists()
assert 'DESK_TERMINAL_TOKEN' not in os.environ
assert 'DESK_COMPANION_DATA_DIR' not in os.environ
try: pathlib.Path('/usr/write-test').write_text('unsafe')
except OSError: pass
else: raise AssertionError('runtime writable')
try: pathlib.Path('/escape').write_text('unsafe')
except OSError: pass
else: raise AssertionError('root writable')
s = socket.socket(); s.settimeout(1)
try: s.connect(('1.1.1.1', 443))
except OSError: pass
else: raise AssertionError('network visible')
pathlib.Path('result.md').write_text('# 结果\\n你好', encoding='utf-8')
print('{"kind":"exit","state":"succeeded"}')
print('中文输出')
'''
        job = self.start("python3 - <<'PY'\n" + script + "\nPY")
        self.assertEqual(self.wait(job)["state"], "succeeded")
        self.assertIn("中文输出", self.output(job))
        self.assertTrue(self.manager.preview_file("s", "result.md")["sources"])
        # Relative symlinks to outside the workspace are never followed by host preview.
        job = self.start("ln -s /mnt/c/Windows/win.ini escape.txt")
        self.assertEqual(self.wait(job)["state"], "succeeded")
        with self.assertRaises(ValueError):
            self.manager.preview_file("s", "escape.txt")

    def test_real_interactive_pty_input_and_request_deduplication(self):
        job = self.start('read -r -p "请输入: " answer; printf "收到: %s\\n" "$answer"')
        duplicate = self.manager.start(job["command"], session="s", request_id=job["request_id"])["job"]
        self.assertEqual(duplicate["id"], job["id"])
        self.wait(job, "running")
        self.manager.input(job["id"], cols=90, rows=24)
        self.manager.input(job["id"], text="你好\r")
        self.assertEqual(self.wait(job)["state"], "succeeded")
        self.assertIn("收到: 你好", self.output(job))

    def test_real_cancel_removes_background_child_and_task_cancellation(self):
        job = self.start("(sleep 3; echo orphan > orphan.txt) & echo READY; sleep 30", owner="agent", task_id="t")
        self.wait(job, "running")
        deadline = time.monotonic() + 5
        while "READY" not in self.output(job) and time.monotonic() < deadline:
            time.sleep(.05)
        self.assertIn("READY", self.output(job))
        self.manager.cancel_task("t")
        self.assertEqual(self.wait(job)["state"], "cancelled")
        time.sleep(3.2)
        self.assertFalse((terminal.workspace("s") / "orphan.txt").exists())

    def test_real_timeout_nonzero_exit_and_output_limit(self):
        job = self.start("sleep 10", timeout=1)
        self.assertEqual(self.wait(job)["state"], "timed_out")
        job = self.start("echo failed >&2; exit 7")
        value = self.wait(job)
        self.assertEqual(value["state"], "failed"); self.assertEqual(value["exit_code"], 7)
        self.assertIn("failed", self.output(job))
        job = self.start("python3 -c \"import sys; sys.stdout.write('x'*5000000)\"")
        value = self.wait(job)
        self.assertEqual(value["state"], "output_limit")
        self.assertLessEqual(value["output_bytes"], 4 * 1024**2)


if __name__ == "__main__":
    unittest.main()
