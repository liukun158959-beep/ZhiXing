import copy
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch

from desk_companion.collaboration import Collaboration, parse_plan, transaction
from desk_companion.collaboration_worker import execute

MODEL = dict(id="model-one", model="fixture-model", base_url="https://example.invalid/v1", api_key="fixture-key")


class Queue:
    def __init__(self):
        self.settings = {}; self.items = {}; self.requests = {}

    def submit(self, text, session, channel, submission_key="", **request):
        if submission_key not in self.items:
            self.items[submission_key] = dict(id=submission_key, state="queued", answer="", error="", events=[])
            self.requests[submission_key] = dict(text=text, session_id=session, **request)
        return submission_key

    def get(self, task): return copy.deepcopy(self.items[task])
    def cancel(self, task): self.items[task]["state"] = "cancelled"
    def shutdown(self): pass

    def complete(self, task, answer, applied=0, state="succeeded", evidence=None):
        row = self.items[task]; row.update(state=state, answer=answer, error="测试失败" if state == "failed" else "")
        row["events"] = [dict(seq=1, kind="llm_start", data={}), dict(seq=2, kind="collab_applied", data=applied),
                         dict(seq=3, kind="usage", data=dict(input_tokens=10, output_tokens=5))]
        if evidence: row["events"].append(dict(seq=4, kind="evidence", data=evidence))


class CollaborationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"DESK_COMPANION_DATA_DIR": self.temp.name}); self.env.start()
        self.model = patch("desk_companion.model_catalog.require_active", return_value=MODEL); self.model.start()
        self.item = patch("desk_companion.model_catalog.require_item", return_value=MODEL); self.item.start()
        self.work, self.chat = Queue(), Queue()
        self.service = Collaboration(path=Path(self.temp.name)/"workspace.sqlite3", managers=dict(work=self.work, chat=self.chat), start=False)

    def tearDown(self):
        self.service.shutdown(); self.item.stop(); self.model.stop(); self.env.stop(); self.temp.cleanup()

    def state(self): return self.service.snapshot()["state"]

    def action(self, **values):
        return self.service.action(dict(request_id=uuid.uuid4().hex, conversation="group-research", **values))["state"]

    def plan(self, dependency=0):
        return json.dumps({"tasks": [dict(agent_id="research", title="研究", instructions="根据提供材料研究", depends_on=None),
            dict(agent_id="writer", title="报告", instructions="根据研究成果写报告", depends_on=dependency)]})

    def test_duplicate_messages_and_separate_chat_queue(self):
        action = dict(type="send", conversation="group-research", text="比较材料", target="", mode="task", request_id="same-request-0001")
        self.service.action(action); self.service.action(action)
        self.assertEqual(len(self.state()["runs"]), 1)
        self.service.tick(); self.assertEqual(len(self.work.items), 1)
        self.action(type="send", text="现在能聊天吗", target="", mode="message")
        self.service.tick(); self.assertEqual(len(self.chat.items), 1)
        self.assertEqual(len(self.work.items), 1)
        with self.assertRaisesRegex(ValueError, "另一项操作"):
            self.service.action({**action, "text": "不同消息"})

    def test_valid_plan_handoff_and_failure_never_uses_empty_result(self):
        self.action(type="send", text="研究并写作", target="", mode="task"); self.service.tick()
        self.work.complete(next(iter(self.work.items)), self.plan())
        self.service.tick(); state = self.state()
        self.assertEqual([r["state"] for r in state["runs"]], ["succeeded", "pending", "waiting"])
        self.service.tick(); research = self.state()["runs"][1]
        task = "collab:"+research["id"]+":0"
        self.work.complete(task, "已有来源的真实研究结果", evidence=dict(query="官方来源",text="SOURCE_LEDGER_SENTINEL")); self.service.tick(); self.service.tick()
        writer = self.state()["runs"][2]
        self.assertEqual(writer["state"], "queued")
        self.service.tick(); request = self.work.requests["collab:"+writer["id"]+":0"]
        self.assertIn("已有来源的真实研究结果", json.dumps(request, ensure_ascii=False))
        self.assertIn("SOURCE_LEDGER_SENTINEL", json.dumps(request, ensure_ascii=False))
        self.work.complete("collab:"+writer["id"]+":0", "", state="failed"); self.service.tick()
        self.assertEqual(self.state()["runs"][2]["state"], "failed")
        self.assertNotIn("artifact", self.state()["runs"][2])

    def test_cancel_planner_and_children_does_not_stop_independent_work(self):
        self.action(type="send", text="团队任务", target="", mode="task"); self.service.tick()
        root = self.state()["runs"][0]
        self.work.complete("collab:"+root["id"]+":0", self.plan()); self.service.tick(); self.service.tick()
        self.action(type="send", text="独立查询", target="research", mode="task"); self.service.tick()
        self.action(type="cancel", id=root["id"]); self.service.tick()
        rows = self.state()["runs"]
        self.assertEqual(rows[1]["state"], "cancelled"); self.assertEqual(rows[2]["state"], "cancelled")
        self.assertEqual(rows[3]["state"], "queued")

    def test_failed_dependency_never_dispatches_its_writer(self):
        self.action(type="send", text="团队任务", target="", mode="task"); self.service.tick()
        root = self.state()["runs"][0]
        self.work.complete("collab:"+root["id"]+":0", self.plan()); self.service.tick(); self.service.tick()
        research = self.state()["runs"][1]
        self.work.complete("collab:"+research["id"]+":0", "部分资料", state="failed"); self.service.tick()
        rows = self.state()["runs"]
        self.assertEqual(rows[2]["state"], "cancelled")
        self.assertEqual(len(self.work.items), 2)
        self.assertNotIn("artifact", rows[1])

    def test_late_update_blocks_handoff_and_creates_bounded_revision(self):
        self.action(type="send", text="写一份报告", target="research", mode="task"); self.service.tick()
        run = self.state()["runs"][0]; task = "collab:"+run["id"]+":0"
        self.work.complete(task, "旧稿")
        self.action(type="send", text="重点是部署成本", run=run["id"], mode="task")
        self.service.tick(); self.assertEqual(self.state()["runs"][0]["state"], "pending")
        self.service.tick(); revised = "collab:"+run["id"]+":1"
        self.assertEqual(self.work.requests[revised]["draft"], "旧稿")
        self.work.complete(revised, "按成本修订的成果", applied=1); self.service.tick()
        state = self.state(); self.assertEqual(state["runs"][0]["artifact"], "按成本修订的成果")
        with self.assertRaises(ValueError): self.action(type="send", text="结束后补充", run=run["id"], mode="task")

    def test_private_memory_is_not_in_other_agents_or_group_context(self):
        agent = self.state()["agents"][1]
        self.action(type="agent", agent={**agent, "memory": "RESEARCH_PRIVATE_SENTINEL"})
        self.action(type="send", text="你好", target="writer", mode="message"); self.service.tick()
        request = next(iter(self.chat.requests.values()))
        self.assertNotIn("RESEARCH_PRIVATE_SENTINEL", json.dumps(request))
        self.assertTrue(any(row["sender"] == "group_goal" for row in request["context"]))
        self.assertNotIn("agent_config", self.state()["runs"][0])
        with self.assertRaises(ValueError): self.action(type="agent", agent={**agent, "tools": ["飞书"]})
        with self.assertRaises(ValueError): self.action(type="send", text="@不存在的成员 帮忙", mode="task")

    def test_queue_submission_recovers_without_duplicate_work_after_partial_commit(self):
        self.action(type="send", text="任务", target="research", mode="task"); self.service.tick()
        task = next(iter(self.work.items))
        with transaction(self.service.path) as (state, _):
            state["runs"][0].update(state="pending", task="")
        self.service.tick(); self.assertEqual(len(self.work.items), 1)
        self.work.complete(task, "完成"); self.service.tick(); self.service.tick()
        self.assertEqual(len(self.work.items), 1)

    def test_plans_cannot_escape_members_or_create_cycles(self):
        for value in [dict(tasks=[dict(agent_id="stranger", title="a", instructions="a", depends_on=None)]),
                      dict(tasks=[dict(agent_id="research", title="a", instructions="a", depends_on=0)]),
                      dict(tasks=[dict(agent_id="research", title="a", instructions="a", depends_on=False)])]:
            with self.assertRaises(ValueError): parse_plan(json.dumps(value), {"research"})

    def request(self, role=None):
        self.action(type="send", text="根据材料写作", target="research", mode="task"); self.service.tick()
        request = copy.deepcopy(next(iter(self.work.requests.values())))
        request["limits"] = dict(call_timeout=10, task_timeout=30)
        if role is not None: request["role"] = role
        return request

    def test_real_worker_search_then_response_and_usage(self):
        request = self.request(); events = []; inputs = []; queries = []
        class LLM:
            def chat(_, messages, tools, on_delta):
                inputs.append(copy.deepcopy(messages))
                if len(inputs) == 1:
                    return dict(message=dict(role="assistant", content="", tool_calls=[dict(id="tool-1", type="function", function=dict(name="web_search", arguments='{"query":"official source"}'))]), usage={})
                on_delta("有出处的结论")
                return dict(message=dict(content="有出处的结论"), usage=dict(prompt_tokens=5, completion_tokens=3))
        execute(request, lambda kind, data: events.append((kind, data)), llm=LLM(), search=lambda query: queries.append(query) or "来源：https://example.org/docs")
        self.assertEqual(queries, ["official source"])
        self.assertIn("https://example.org/docs", json.dumps(inputs[-1]))
        self.assertEqual(events[-1], ("result", "有出处的结论"))
        self.assertEqual(sum(kind == "tool_start" for kind, _ in events), 1)

    def test_worker_applies_during_call_update_and_drops_old_draft(self):
        request = self.request(); calls = []; events = []
        class LLM:
            def chat(_, messages, tools, on_delta):
                calls.append(copy.deepcopy(messages)); on_delta("旧稿" if len(calls) == 1 else "新稿")
                if len(calls) == 1:
                    with transaction(self.service.path) as (state, _): state["runs"][0]["updates"].append("新约束")
                return dict(message=dict(content="旧稿" if len(calls) == 1 else "新稿"), usage={})
        execute(request, lambda kind, data: events.append((kind, data)), llm=LLM())
        self.assertIn("新约束", json.dumps(calls[1], ensure_ascii=False)); self.assertIn(("answer_reset", True), events)
        self.assertEqual(events[-1], ("result", "新稿"))

    def test_worker_denies_ungranted_tools_before_execution(self):
        request = self.request(); events = []
        class LLM:
            def chat(_, messages, tools, on_delta):
                return dict(message=dict(tool_calls=[dict(id="bad", function=dict(name="send_feishu", arguments="{}"))]), usage={})
        with self.assertRaises(ValueError): execute(request, lambda kind, data: events.append((kind, data)), llm=LLM())
        self.assertFalse(any(kind == "tool_start" for kind, _ in events))

    def test_failed_search_can_rephrase_within_budget_and_keeps_actual_evidence(self):
        request = self.request(); events = []; calls = []; searches = []
        class LLM:
            def chat(_, messages, tools, on_delta):
                calls.append(copy.deepcopy(messages))
                if len(calls) < 3:
                    return dict(message=dict(role="assistant",tool_calls=[dict(id="tool-"+str(len(calls)),type="function",function=dict(name="web_search",arguments=json.dumps(dict(query="query-"+str(len(calls))))))]),usage={})
                return dict(message=dict(content="有证据的结果"),usage={})
        def search(query):
            searches.append(query)
            if len(searches)==1: raise RuntimeError("没有结果 fixture-key")
            return "来源：https://example.org/verified"
        execute(request,lambda kind,data:events.append((kind,data)),llm=LLM(),search=search)
        self.assertEqual(len(searches),2);self.assertNotIn("fixture-key",json.dumps(events))
        self.assertTrue(any(kind=="evidence" and "verified" in data["text"] for kind,data in events))
        self.assertEqual(events[-1],("result","有证据的结果"))

    def test_no_successful_search_never_delivers_an_unverified_report(self):
        from desk_companion.collaboration_worker import PublicFailure
        request=self.request();events=[];calls=[]
        class LLM:
            def chat(_,messages,tools,on_delta):
                calls.append(True)
                if len(calls)==1: return dict(message=dict(role="assistant",tool_calls=[dict(id="tool-1",type="function",function=dict(name="web_search",arguments='{"query":"official"}'))]),usage={})
                return dict(message=dict(content="无依据的报告"),usage={})
        def search(_): raise RuntimeError("没有结果 fixture-key")
        with self.assertRaises(PublicFailure) as error: execute(request,lambda kind,data:events.append((kind,data)),llm=LLM(),search=search)
        self.assertNotIn("fixture-key",str(error.exception));self.assertFalse(any(kind=="result" for kind,_ in events))


class PreviewAccessTests(unittest.TestCase):
    def test_first_collaboration_connection_does_not_wait_for_desktop_chat_lock(self):
        from desk_companion.local_api.host import HeadlessApp
        host=HeadlessApp.__new__(HeadlessApp)
        host.turn_lock=threading.RLock();host._collaboration_lock=threading.Lock();host._collaboration=None
        ready=threading.Event();sentinel=object()
        def connect():
            if host.collaboration is sentinel:ready.set()
        with patch("desk_companion.collaboration.Collaboration",return_value=sentinel):
            with host.turn_lock:
                thread=threading.Thread(target=connect);thread.start()
                self.assertTrue(ready.wait(1))
            thread.join(1)

    def test_capability_expires_and_requires_an_exact_local_origin(self):
        from desk_companion.collaboration_access import preview_allowed, access_path
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"DESK_COMPANION_DATA_DIR": temp}):
            path = access_path(); path.parent.mkdir(parents=True)
            path.write_text(json.dumps(dict(token="x"*48, expires=200)), "utf-8")
            with patch("time.time", return_value=100):
                self.assertTrue(preview_allowed("x"*48, "http://127.0.0.1:5180"))
                self.assertFalse(preview_allowed("x"*48, "https://example.org"))
                self.assertFalse(preview_allowed("y"*48, "http://127.0.0.1:5180"))
            with patch("time.time", return_value=201): self.assertFalse(preview_allowed("x"*48, "http://127.0.0.1:5180"))


class PreviewRpcTests(unittest.IsolatedAsyncioTestCase):
    async def test_browser_capability_cannot_access_general_rpc_or_chat(self):
        from desk_companion.local_api import server
        class Socket:
            def __init__(self):
                from types import SimpleNamespace
                self.request = SimpleNamespace(path="/collaboration?token="+"x"*48, headers={"Origin":"http://127.0.0.1:5180"})
                self.messages = iter([dict(type="rpc",method="terminal_start",args={}), dict(type="chat",text="bad"), dict(type="rpc",method="load_collaboration")]); self.replies=[]
            def __aiter__(self): return self
            async def __anext__(self):
                try: return json.dumps(next(self.messages))
                except StopIteration: raise StopAsyncIteration
            async def send(self, raw): self.replies.append(json.loads(raw))
            async def close(self, **kwargs): raise AssertionError("valid scoped connection should not be closed")
        socket = Socket()
        with patch("desk_companion.collaboration_access.preview_allowed", return_value=True), patch.object(server,"_dispatch",return_value=dict(ok=True,result={})) as dispatch:
            await server._handler(socket)
        self.assertEqual(dispatch.call_count,1);self.assertEqual(dispatch.call_args.args[0],"load_collaboration")
        self.assertEqual([reply["type"] for reply in socket.replies],["error","error","rpc_result"])


if __name__ == "__main__": unittest.main()
