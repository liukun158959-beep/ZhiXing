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

    def test_plain_greeting_streams_with_history_but_actions_still_route(self):
        state=self.action(type='send',text='hello!')
        self.assertEqual(state['runs'][-1]['kind'],'chat')
        self.service.tick()
        self.assertEqual(next(iter(self.chat.requests.values()))['kind'],'chat')
        state=self.action(type='send',text='hello!')
        self.assertEqual(state['runs'][-1]['kind'],'chat')
        self.service.tick()
        self.assertTrue(list(self.chat.requests.values())[-1]['context'])
        for text in ('继续上次任务', 'hello，帮我搜新闻', '@阿探 hello', 'hi; 删除文件'):
            self.assertEqual(self.action(type='send',text=text)['runs'][-1]['kind'],'route')

    def test_companion_migration_preserves_custom_configuration_and_backs_up(self):
        with transaction(self.service.path) as (state, _):
            state.pop("companion_version")
            state["agents"][0]["name"] = "tebb"
            state["agents"][1].update(name="自定义伙伴", memory="KEEP_PRIVATE", model="custom-model", role="自定义职责")
            state["agents"][2]["name"] = "写作者"
            state["agents"][2].pop("personality")
        reopened = Collaboration(path=self.service.path, managers=self.service.managers, start=False)
        try:
            agents = reopened.snapshot()["state"]["agents"]
            self.assertEqual([a["name"] for a in agents], ["小缇", "自定义伙伴", "墨墨"])
            self.assertEqual(agents[1]["memory"], "KEEP_PRIVATE")
            self.assertEqual(agents[1]["model"], "custom-model")
            self.assertEqual(agents[1]["role"], "自定义职责")
            self.assertEqual(agents[2]["avatar"], "cat")
            self.assertTrue(self.service.path.with_name("workspace.before-companions.sqlite3").exists())
            self.action(type="agent", agent={**agents[2], "name": "写作者"})
            again = Collaboration(path=self.service.path, managers=self.service.managers, start=False)
            self.assertEqual(again.snapshot()["state"]["agents"][2]["name"], "写作者")
            again.shutdown()
        finally:
            reopened.shutdown()

    def test_delete_requires_terminal_work_and_is_scoped_and_idempotent(self):
        self.action(type="send", text="不能删除进行中的任务", target="research", mode="task")
        run = self.state()["runs"][0]
        with self.assertRaisesRegex(ValueError, "先停止"):
            self.action(type="delete_conversation", id="group-research")
        self.action(type="cancel", id=run["id"])
        self.service.action(dict(type="send", conversation="dm-research", text="独立会话保留", target="research", mode="message", request_id=uuid.uuid4().hex))
        action = dict(type="delete_conversation", id="group-research", request_id="delete-test-001")
        self.service.action(action); self.service.action(action)
        state = self.state()
        self.assertFalse(any(c["id"] == "group-research" for c in state["conversations"]))
        self.assertFalse(any(r["conversation"] == "group-research" for r in state["runs"]))
        self.assertTrue(any(m["text"] == "独立会话保留" for m in state["messages"]))
        self.assertIn(state["selected"], [c["id"] for c in state["conversations"]])
        self.assertEqual(len(state["agents"]), 3)
        with self.assertRaisesRegex(ValueError, "会话不存在"):
            self.action(type="send", text="过期入口不能重建旧对话", target="", mode="message")

    def test_deleted_dm_reopens_empty_with_private_memory_and_new_identity(self):
        agent = self.state()["agents"][1]
        self.action(type="agent", agent={**agent, "memory": "PRIVATE_KEEP", "avatar": "owl", "personality": "好奇温柔"})
        self.action(type="delete_conversation", id="dm-research")
        state = self.action(type="open_dm", agent_id="research")
        self.assertNotEqual(state["selected"], "dm-research")
        self.assertFalse(any(m["conversation"] == state["selected"] for m in state["messages"]))
        self.assertEqual(state["agents"][1]["memory"], "PRIVATE_KEEP")
        self.service.action(dict(type="send", conversation=state["selected"], text="你好", target="", mode="message", request_id=uuid.uuid4().hex))
        self.service.tick()
        request = next(iter(self.chat.requests.values()))
        self.assertEqual(request["role"]["personality"], "好奇温柔")
        self.assertEqual(request["role"]["avatar"], "owl")

    def test_last_conversation_delete_always_leaves_a_valid_empty_chat(self):
        for c in list(self.state()["conversations"]):
            self.action(type="delete_conversation", id=c["id"])
        state = self.state()
        self.assertEqual(len(state["conversations"]), 1)
        self.assertEqual(state["selected"], state["conversations"][0]["id"])
        self.assertEqual(state["messages"], [])

    def test_group_rename_and_avatar_validation(self):
        state = self.action(type="rename_conversation", id="group-research", title="灵感工作室")
        self.assertEqual(state["conversations"][0]["title"], "灵感工作室")
        with self.assertRaises(ValueError):
            self.action(type="rename_conversation", id="dm-research", title="不能改成群名")
        for avatar in ("https://tracking.invalid/a.svg", [], None):
            with self.assertRaisesRegex(ValueError, "头像无效"):
                self.action(type="agent", agent={**state["agents"][0], "avatar": avatar})

    def test_auto_answer_stays_chat_and_auto_task_hands_off_without_manual_mode(self):
        self.action(type='send', text='介绍一下你能做什么', mode='auto', target='')
        self.service.tick(); root = self.state()['runs'][-1]
        self.assertEqual(root['kind'],'route'); self.assertEqual(len(self.work.items),0)
        self.chat.complete('collab:'+root['id']+':0',json.dumps(dict(mode='answer',text='你好！')))
        self.service.tick(); self.assertEqual(self.state()['runs'][-1]['answer'],'你好！')
        self.assertEqual(len(self.state()['runs']),1)
        self.action(type='send',text='研究并写成报告',mode='auto',target='')
        self.service.tick(); root=self.state()['runs'][-1]
        self.chat.complete('collab:'+root['id']+':0',json.dumps(dict(mode='task',instructions='研究并写成报告')))
        self.service.tick(); child=self.state()['runs'][-1]
        self.assertEqual(child['kind'],'plan');self.assertEqual(child['parent'],root['id'])
        self.assertIn('研究并写成报告',child['input'] if 'input' in child else child['title'])

    def test_route_accepts_plain_code_in_one_call_without_executing_tools(self):
        request=self.request();request['kind']='route'
        code='```python\ndef bubble_sort(a):\n    pass\n```';calls=[];events=[]
        class LLM:
            def chat(_,messages,tools,on_delta):
                calls.append(copy.deepcopy(messages)); self.assertEqual([t['function']['name'] for t in tools],['start_background_task'])
                return dict(message=dict(content=code if len(calls)==1 else json.dumps(dict(mode='answer',text=code))),usage={})
        execute(request,lambda k,d:events.append((k,d)),llm=LLM())
        self.assertEqual(len(calls),1)
        self.assertEqual(json.loads(events[-1][1])['text'],code)
        self.assertFalse(any(k=='tool_start' for k,d in events))
        self.assertFalse(any(k=='status' and '纠正' in d for k,d in events))

    def test_invalid_route_repair_is_bounded_and_cannot_dispatch(self):
        from desk_companion.collaboration_worker import PublicFailure
        request=self.request();request['kind']='route';calls=[];events=[]
        class LLM:
            def chat(_,messages,tools,on_delta):
                calls.append(1);return dict(message=dict(content='{"mode":"wrong"}'),usage={})
        with self.assertRaisesRegex(PublicFailure,'未执行工具'):
            execute(request,lambda k,d:events.append((k,d)),llm=LLM())
        self.assertEqual(len(calls),2)
        self.assertFalse(any(k in {'tool_start','result'} for k,d in events))

    def test_shared_task_limits_apply_to_collaboration_without_rewriting_existing_jobs(self):
        from desk_companion.collaboration import execution_limits
        folder=Path(self.temp.name)/'memory';folder.mkdir(exist_ok=True)
        path=folder/'task_settings.json';path.write_text(json.dumps(dict(call_timeout=150,task_timeout=900)))
        self.assertEqual(execution_limits('coder'),dict(call_timeout=150,task_timeout=900))
        self.action(type='send',text='写代码',mode='task',target='research');self.service.tick()
        saved=next(iter(self.work.requests.values()))['task_limits']
        self.assertEqual(saved,dict(call_timeout=150,task_timeout=900))
        path.write_text(json.dumps(dict(call_timeout=20,task_timeout=40)))
        self.assertEqual(saved,dict(call_timeout=150,task_timeout=900))
        self.assertEqual(execution_limits('research'),dict(call_timeout=20,task_timeout=40))

    def test_route_function_requests_one_background_task_without_running_it(self):
        request=self.request();request['kind']='route';events=[]
        class LLM:
            def chat(_,messages,tools,on_delta):
                return dict(message=dict(tool_calls=[dict(function=dict(name='start_background_task',arguments=json.dumps(dict(instructions='读取app.py并运行测试'))))]),usage={})
        execute(request,lambda k,d:events.append((k,d)),llm=LLM())
        self.assertEqual(json.loads(events[-1][1]),dict(mode='task',instructions='读取app.py并运行测试'))
        self.assertFalse(any(k=='tool_start' for k,d in events))

    def test_chat_artifact_can_be_saved_once_as_note_and_read_as_full_attachment(self):
        from desk_companion.bridge import Bridge
        from desk_companion import notebook, local_sources
        from types import SimpleNamespace
        bridge=Bridge(SimpleNamespace(collaboration=self.service))
        self.action(type='send',text='生成一份说明',mode='message',target='research');self.service.tick()
        run=self.state()['runs'][-1]
        with self.assertRaisesRegex(ValueError,'成功完成'):bridge.save_collaboration_note(run['id'])
        body='成果正文。'*2000
        self.chat.complete('collab:'+run['id']+':0',body);self.service.tick()
        with patch('desk_companion.knowledge.public_view',return_value=dict(docs=[])):
            first=bridge.save_collaboration_note(run['id']);second=bridge.save_collaboration_note(run['id'])
            self.assertEqual(first,second)
            book=notebook.load_notebook();self.assertEqual(len(book['sessions'][0]['notes']),1)
            self.assertIn('AI 生成',book['sessions'][0]['notes'][0]['answer'])
            staged=bridge.prepare_notebook_source(first['session_id'],first['note_id'])
        self.assertEqual(len(staged['sources']),1)
        snapshot=local_sources.get(staged['sources'][0]['id'])
        self.assertIn(body,snapshot['text']);self.assertIn('未经额外来源核验',snapshot['text'])

    def test_multiple_mentions_limit_delegation_and_literal_code_is_not_a_mention(self):
        self.action(type='send',text='@阿探 @墨墨 一起研究',mode='auto',target='')
        self.service.tick(); root=self.state()['runs'][-1]
        self.chat.complete('collab:'+root['id']+':0',json.dumps(dict(mode='answer',text='不能只聊天')))
        self.service.tick()
        with transaction(self.service.path) as (state,_):
            self.assertEqual({m['id'] for m in state['runs'][-1]['members']},{'research','writer'})
        self.action(type='send',text='解释代码：```python\n@dataclass\nclass A: pass\n```',mode='auto',target='')
        with self.assertRaises(ValueError): self.action(type='send',text='@不存在 帮忙',mode='auto',target='')

    def test_browser_capability_cannot_enable_or_execute_local_tools(self):
        with self.assertRaises(ValueError):
            self.service.action(dict(type='add_coder',request_id=uuid.uuid4().hex),readonly=True)
        agent=self.state()['agents'][0]
        with self.assertRaises(ValueError):
            self.service.action(dict(type='agent',agent={**agent,'tools':['文件编辑']},request_id=uuid.uuid4().hex),readonly=True)
        self.action(type='add_coder')
        self.service.action(dict(type='send',conversation='dm-coder',text='写文件',mode='auto',target='',request_id=uuid.uuid4().hex))
        with self.assertRaises(ValueError):
            self.service.action(dict(type='send',conversation='dm-coder',text='写文件',mode='auto',target='',request_id=uuid.uuid4().hex),readonly=True)

    def test_legacy_history_import_is_once_and_continuable_without_changing_original(self):
        from desk_companion.memory import append_chat, memory_path
        append_chat('user','旧对话问题','legacy-one'); append_chat('pet','旧对话回答','legacy-one')
        raw=memory_path().read_bytes()
        with transaction(self.service.path) as (state,_): state.pop('legacy_imported',None)
        reopened=Collaboration(path=self.service.path,managers=self.service.managers,start=False)
        try:
            state=reopened.snapshot()['state']; conversation=next(c for c in state['conversations'] if c.get('legacy'))
            self.assertEqual([m['text'] for m in state['messages'] if m['conversation']==conversation['id']],['旧对话问题','旧对话回答'])
            reopened.action(dict(type='send',conversation=conversation['id'],text='继续',mode='auto',target='',request_id=uuid.uuid4().hex))
            with transaction(self.service.path) as (current,_): self.assertIn('旧对话回答',json.dumps(current['runs'][-1]['context'],ensure_ascii=False))
            self.assertEqual(memory_path().read_bytes(),raw)
        finally: reopened.shutdown()

    def test_coder_real_file_tool_loop_records_failure_fix_and_fresh_verification(self):
        from desk_companion import project_workspace as project
        folder=Path(self.temp.name)/'code';folder.mkdir();(folder/'app.py').write_bytes(b'value = 1\n')
        cfg=project.save(str(folder),[],True,True)['workspace']
        request=self.request(role=dict(id='coder',name='码可',role='修改并验证',tools=['工作区读取','文件编辑','终端'],memory=''))
        request.update(workspace=cfg,budget=6)
        calls=[];events=[]
        class LLM:
            def chat(_,messages,tools,on_delta):
                calls.append(messages)
                step=len(calls)
                if step in (1,3,5):
                    name='workspace_run';arguments=dict(command='python -m unittest',timeout=20)
                elif step in (2,4):
                    name='workspace_write';arguments=dict(path='app.py',text='value = 2\n' if step==2 else 'value = 3\n',revision=project.read('main','app.py')['revision'])
                else: return dict(message=dict(content='已修改，验证结果见回执。'),usage={})
                return dict(message=dict(role='assistant',tool_calls=[dict(id=str(step),type='function',function=dict(name=name,arguments=json.dumps(arguments)))]),usage={})
        count=[0]
        def command(*_):
            count[0]+=1
            return dict(command='python -m unittest',state='failed' if count[0]<3 else 'succeeded',exit_code=1 if count[0]<3 else 0,output='fixture test',changes=[])
        with patch('desk_companion.project_workspace.run',side_effect=command): execute(request,lambda k,d:events.append((k,d)),llm=LLM())
        self.assertEqual((folder/'app.py').read_text(),'value = 3\n')
        self.assertEqual(len([e for e in events if e[0]=='file_change']),2)
        self.assertEqual([e[1]['exit_code'] for e in events if e[0]=='verification'],[1,1,0])
        self.assertIn('实际验证回执',events[-1][1])
        self.assertNotIn('fixture-key',json.dumps(events))

    def test_coder_without_directory_can_generate_code_but_has_no_file_tools(self):
        request = self.request(role=dict(id='coder',name='码可',role='编程伙伴',tools=['工作区读取','文件编辑','终端']))
        request.update(text='帮我写一个冒泡排序', workspace={})
        calls=[]; events=[]
        class LLM:
            def chat(_,messages,tools,on_delta):
                calls.append((messages,tools)); on_delta('```python\ndef bubble_sort(a): return sorted(a)\n```')
                return dict(message=dict(content='代码示例；尚未运行验证。'),usage=dict(prompt_tokens=10,completion_tokens=8))
        with patch('desk_companion.project_workspace.lease') as lease:
            execute(request,lambda k,d:events.append((k,d)),llm=LLM())
        lease.assert_not_called()
        self.assertEqual(len(calls),1); self.assertEqual(calls[0][1],[])
        self.assertTrue(any(k=='token' for k,d in events))
        self.assertIn('无需工作目录',calls[0][0][0]['content'])

    def test_coder_cannot_invent_write_tool_without_directory_or_permission(self):
        from desk_companion import project_workspace as project
        folder=Path(self.temp.name)/'readonly'; folder.mkdir()
        cfg=project.save(str(folder),[],False,False)['workspace']
        request=self.request(role=dict(id='coder',name='码可',role='编程伙伴',tools=['工作区读取','文件编辑','终端']))
        seen=[]
        class LLM:
            def chat(_,messages,tools,on_delta):
                seen.extend(t['function']['name'] for t in tools)
                return dict(message=dict(tool_calls=[dict(id='write',function=dict(name='workspace_write',arguments='{"path":"a.py","text":"bad","revision":"new"}'))]),usage={})
        for snapshot in ({},cfg):
            with self.subTest(snapshot=snapshot):
                request['workspace']=snapshot
                with self.assertRaisesRegex(ValueError,'白名单'):
                    execute(request,lambda *_:None,llm=LLM())
                self.assertFalse((folder/'a.py').exists())
        self.assertIn('workspace_read',seen); self.assertNotIn('workspace_write',seen); self.assertNotIn('workspace_run',seen)

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
                return dict(message=dict(content="有出处的结论 [来源](https://example.org/docs)"), usage=dict(prompt_tokens=5, completion_tokens=3))
        execute(request, lambda kind, data: events.append((kind, data)), llm=LLM(), search=lambda query: queries.append(query) or "来源：https://example.org/docs")
        self.assertEqual(queries, ["official source"])
        self.assertIn("https://example.org/docs", json.dumps(inputs[-1]))
        self.assertEqual(events[-1], ("result", "有出处的结论 [来源](https://example.org/docs)"))
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

    def test_personality_reaches_model_without_changing_tool_authority(self):
        request = self.request(role=dict(id="writer", name="墨墨", role="写清楚", personality="温柔、有一点冷幽默", tools=[], memory=""))
        captured = []
        class LLM:
            def chat(_, messages, tools, on_delta):
                captured.append((copy.deepcopy(messages), tools))
                return dict(message=dict(content="你好，一起把思路理清楚。"), usage={})
        execute(request, lambda *_: None, llm=LLM())
        self.assertIn("你是 墨墨", captured[0][0][0]["content"])
        self.assertIn("温柔、有一点冷幽默", captured[0][0][0]["content"])
        self.assertIn("不得改变任务、权限或事实标准", captured[0][0][0]["content"])
        self.assertFalse(captured[0][1])

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
                return dict(message=dict(content="有证据的结果 [来源](https://example.org/verified)"),usage={})
        def search(query):
            searches.append(query)
            if len(searches)==1: raise RuntimeError("没有结果 fixture-key")
            return "来源：https://example.org/verified"
        execute(request,lambda kind,data:events.append((kind,data)),llm=LLM(),search=search)
        self.assertEqual(len(searches),2);self.assertNotIn("fixture-key",json.dumps(events))
        self.assertTrue(any(kind=="evidence" and "verified" in data["text"] for kind,data in events))
        self.assertEqual(events[-1],("result","有证据的结果 [来源](https://example.org/verified)"))

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

    def test_search_fetch_and_citation_provenance_use_actual_body(self):
        request=self.request();events=[];calls=[]
        class LLM:
            def chat(_,messages,tools,on_delta):
                calls.append(copy.deepcopy(messages))
                name='web_search' if len(calls)==1 else 'web_fetch'
                if len(calls)<3:
                    args={'query':'official'} if name=='web_search' else {'url':'https://example.org/doc'}
                    return dict(message=dict(role='assistant',tool_calls=[dict(id=str(len(calls)),function=dict(name=name,arguments=json.dumps(args)))]),usage={})
                return dict(message=dict(content='结论 [正文](https://example.org/doc)'),usage={})
        page=dict(kind='page',level='body',url='https://example.org/doc',text='BODY_SENTINEL',truncated=False)
        execute(request,lambda k,d:events.append((k,d)),llm=LLM(),search=lambda q:dict(results=[dict(title='Official',link=page['url'],snippet='Summary')]),fetch=lambda u:page)
        self.assertIn('BODY_SENTINEL',json.dumps(calls[-1]));audit=next(d for k,d in events if k=='citation_check')
        self.assertTrue(audit['ok']);self.assertEqual(audit['pages_read'],1)
        self.assertEqual(audit['matched'][0]['level'],'body')

    def test_writer_receives_body_evidence_and_repairs_unretrieved_citation(self):
        request=self.request(role=dict(id='writer',name='写作者',role='写报告',tools=[]))
        request['source_evidence']=[dict(kind='page',level='body',url='https://example.org/real',text='BODY_FOR_WRITER',truncated=False)]
        calls=[];events=[]
        class LLM:
            def chat(_,messages,tools,on_delta):
                calls.append(copy.deepcopy(messages))
                return dict(message=dict(content='[source](https://example.org/'+('fake' if len(calls)==1 else 'real')+')'),usage={})
        execute(request,lambda k,d:events.append((k,d)),llm=LLM())
        self.assertEqual(len(calls),2);self.assertIn('BODY_FOR_WRITER',json.dumps(calls[0]))
        self.assertIn(('answer_reset',True),events)
        self.assertEqual([d['ok'] for k,d in events if k=='citation_check'],[False,True])

    def test_fetch_permission_and_known_url_are_enforced_and_no_fake_evidence(self):
        class LLM:
            def chat(_,messages,tools,on_delta):
                return dict(message=dict(role='assistant',tool_calls=[dict(id='fetch',function=dict(name='web_fetch',arguments='{"url":"https://example.org/not-discovered"}'))]),usage={})
        events=[];request=self.request(role=dict(name='writer',role='写作',tools=[]))
        with self.assertRaises(ValueError):execute(request,lambda k,d:events.append((k,d)),llm=LLM())
        self.assertFalse(any(k=='tool_start' for k,d in events))
        events=[];request=self.request()
        with patch('desk_companion.web_sources.fetch_page') as fetch:
            with self.assertRaises(ValueError):execute(request,lambda k,d:events.append((k,d)),llm=LLM())
            fetch.assert_not_called()
        self.assertFalse(any(k=='evidence' for k,d in events))

    def test_repeated_invented_citations_fail_without_handoff(self):
        from desk_companion.collaboration_worker import PublicFailure
        request=self.request();request['source_evidence']=[dict(kind='page',level='body',url='https://example.org/real',text='Real')]
        events=[];calls=[]
        class LLM:
            def chat(_,messages,tools,on_delta):
                calls.append(True)
                return dict(message=dict(content='[fake](https://example.org/fabricated)'),usage={})
        with self.assertRaises(PublicFailure):execute(request,lambda k,d:events.append((k,d)),llm=LLM())
        self.assertEqual(len(calls),2);self.assertFalse(any(k=='result' for k,d in events))

    def test_own_source_evidence_is_carried_into_bounded_revision(self):
        self.action(type='send',text='研究任务',target='research',mode='task');self.service.tick()
        run=self.state()['runs'][0];task='collab:'+run['id']+':0'
        page=dict(kind='page',url='https://example.org/body',level='body',text='PERSISTED_BODY')
        self.work.complete(task,'旧稿',evidence=page)
        self.work.items[task]['events'].extend([dict(seq=5,kind='tool_start',data={'tool':'web_search'}),dict(seq=6,kind='tool_start',data={'tool':'web_fetch'})])
        self.action(type='send',text='修订',run=run['id'],mode='task');self.service.tick();self.service.tick()
        req=self.work.requests['collab:'+run['id']+':1']
        self.assertEqual(req['search_budget'],1);self.assertEqual(req['fetch_budget'],3)
        self.assertIn('PERSISTED_BODY',json.dumps(req))


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
                self.messages = iter([dict(type="rpc",method="terminal_start",args={}),dict(type='rpc',method='load_model_network'),dict(type='rpc',method='save_model_network',args={'payload':{'mode':'direct'}}), dict(type="chat",text="bad"), dict(type="rpc",method="load_collaboration")]); self.replies=[]
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
        self.assertEqual([reply["type"] for reply in socket.replies],["error","error","error","error","rpc_result"])


if __name__ == "__main__": unittest.main()
