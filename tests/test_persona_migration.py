import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from desk_companion import state
from desk_companion.bridge import Bridge


class PersonaMigrationTests(unittest.TestCase):
    def test_legacy_default_migrates_once_with_backup_and_custom_persona_is_preserved(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'DESK_COMPANION_DATA_DIR': folder}):
            current = state.load_state(10, 20)
            current.persona = state.LEGACY_PERSONA; current.save()
            migrated = state.load_state(10,20)
            self.assertEqual(migrated.persona, state.DEFAULT_PERSONA)
            backup = Path(folder)/'user_state.before-tebb-persona.json'
            self.assertEqual(json.loads(backup.read_text('utf-8'))['persona'], state.LEGACY_PERSONA)
            original = backup.read_bytes()
            migrated.persona='用户自定义角色和风格'; migrated.save()
            self.assertEqual(state.load_state(10,20).persona, '用户自定义角色和风格')
            self.assertEqual(backup.read_bytes(),original)

    def test_progress_retains_real_finished_task_without_exposing_reasoning(self):
        task = dict(id='work',state='running',text='验证任务',answer='部分结果',events=[
            dict(seq=1,kind='status',data='正在检查'),dict(seq=2,kind='think',data='private reasoning')])
        tasks = SimpleNamespace(settings={'pet_progress':True},list=lambda:{'items':[task]},get=lambda _id:task)
        host=SimpleNamespace(tasks=tasks);bridge=Bridge(host)
        self.assertEqual(bridge.load_task_progress()['task']['state'],'running')
        task.update(state='succeeded',answer='实际完成')
        result=bridge.load_task_progress()['task']
        self.assertEqual(result['state'],'succeeded');self.assertEqual(result['answer'],'实际完成')
        self.assertEqual(result['events'],['正在检查'])
        tasks.settings['pet_progress']=False
        self.assertFalse(bridge.load_task_progress()['enabled'])
