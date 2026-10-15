import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from desk_companion import project_workspace as project


class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'DESK_COMPANION_DATA_DIR': self.temp.name}); self.env.start()
        self.main = Path(self.temp.name)/'main'; self.main.mkdir()
        self.reference = Path(self.temp.name)/'reference'; self.reference.mkdir()
        (self.main/'app.py').write_bytes(b'value = 1\n')
        (self.reference/'source.md').write_text('# 只读',encoding='utf-8')
        self.config = project.save(str(self.main),[str(self.reference)],edit=True,commands=True)['workspace']

    def tearDown(self):
        self.env.stop(); self.temp.cleanup()

    def test_grants_persist_and_traversal_and_protected_paths_are_denied(self):
        self.assertEqual(project.load(), self.config)
        self.assertEqual(project.tree()['entries'][0]['name'],'app.py')
        for root,path in [('main','../outside'),('ref-0','../main/app.py'),('bad','app.py'),('main','.git/config'),('main','.env'),('main','/etc/passwd')]:
            with self.assertRaises(ValueError): project.read(root,path)
        with self.assertRaises(ValueError): project.save(str(self.main),[str(self.main/'nested')],True,True)

    def test_readonly_reference_and_optimistic_writes_preserve_external_changes(self):
        self.assertFalse(project.read('ref-0','source.md')['editable'])
        before = project.read('main','app.py')
        result = project.write('app.py','value = 2\n',before['revision'],workspace_revision=before['workspace_revision'])
        self.assertIn('-value = 1',result['diff']); self.assertIn('+value = 2',result['diff'])
        self.assertEqual((self.main/'app.py').read_text(),'value = 2\n')
        with self.assertRaisesRegex(ValueError,'已被其他操作修改'):
            project.write('app.py','overwrite',before['revision'])
        project.write('nested/new.py','print(1)','new')
        self.assertEqual((self.main/'nested/new.py').read_text(),'print(1)')
        with self.assertRaises(ValueError): project.write('nested/new.py','oops','new')

    def test_revocation_and_directory_switch_reject_stale_editor_and_worker(self):
        before = project.read('main','app.py')
        project.save(str(self.main),[],edit=False,commands=False)
        with self.assertRaises(ValueError): project.write('app.py','oops',before['revision'])
        with self.assertRaises(ValueError): project.current(self.config)
        other = Path(self.temp.name)/'other'; other.mkdir(); (other/'app.py').write_text('value = 1\n')
        project.save(str(other),[],True,True)
        with self.assertRaisesRegex(ValueError,'目录已切换'):
            project.write('app.py','oops',before['revision'],workspace_revision=before['workspace_revision'])
        self.assertEqual((other/'app.py').read_text(),'value = 1\n')

    def test_write_lease_blocks_edit_and_grant_changes_but_not_reads(self):
        before = project.read('main','app.py')
        with project.lease(str(self.main)):
            self.assertEqual(project.read('main','app.py')['text'],'value = 1\n')
            with self.assertRaises(ValueError): project.write('app.py','oops',before['revision'])
            with self.assertRaises(ValueError): project.save(str(self.main),[],False,False)
            project.write('app.py','value = 3\n',before['revision'],config=self.config,locked=True)
        self.assertEqual((self.main/'app.py').read_text(),'value = 3\n')

    def test_links_are_not_followed(self):
        outside = Path(self.temp.name)/'outside.txt'; outside.write_text('outside')
        try: (self.main/'linked.txt').symlink_to(outside)
        except OSError: self.skipTest('OS does not permit creating test symlinks')
        with self.assertRaises(ValueError): project.read('main','linked.txt')
        with self.assertRaises(ValueError): project.write('linked.txt','oops','new')
        self.assertEqual(outside.read_text(),'outside')

    def test_hardlinks_are_not_editable(self):
        outside = Path(self.temp.name)/'outside.txt'; outside.write_text('outside')
        os.link(outside,self.main/'hard.txt')
        with self.assertRaises(ValueError): project.read('main','hard.txt')
        self.assertEqual(outside.read_text(),'outside')

    def test_sandbox_arguments_mount_references_readonly_and_do_not_pass_environment(self):
        from desk_companion.sandbox_driver import sandbox_args
        args = sandbox_args('/tmp/main','python -m unittest',references=['/tmp/reference'])
        index = args.index('/tmp/reference')
        self.assertEqual(args[index-1],'--ro-bind'); self.assertEqual(args[index+1],'/references/0')
        self.assertIn('--clearenv',args); self.assertIn('--unshare-all',args)
        self.assertNotIn('--share-net',args)

    def test_heartbeat_survives_host_wsl_clock_skew_but_expires_when_unchanged(self):
        from desk_companion.sandbox_driver import lease_alive
        file=Path(self.temp.name)/'lease';file.touch()
        os.utime(file,(1,1))
        clock={}
        self.assertTrue(lease_alive(file,clock,100))
        self.assertTrue(lease_alive(file,clock,107))
        self.assertFalse(lease_alive(file,clock,109))
        os.utime(file,(2,2))
        self.assertTrue(lease_alive(file,clock,110))

    def test_terminal_bridge_uses_granted_project_and_rejects_stale_grants(self):
        from desk_companion.bridge import Bridge
        from types import SimpleNamespace
        bridge=Bridge(SimpleNamespace())
        manager=SimpleNamespace(start=lambda *args,**kwargs: dict(project=kwargs['project'],session=args[1]))
        with patch('desk_companion.terminal.manager',return_value=manager):
            result=bridge.terminal_start('echo ok',session='project:'+self.config['primary'],workspace_revision=self.config['revision'])
            self.assertEqual(result['project'],self.config)
            with self.assertRaises(ValueError): bridge.terminal_start('echo nope',session='project:'+self.config['primary'],workspace_revision='stale')

    def test_verification_command_enforces_failure_propagation(self):
        class Manager:
            def start(_,command,**kwargs):
                self.assertTrue(command.startswith('set -e\nset -o pipefail\n'))
                return {'job':dict(id='test',state='failed',output_bytes=0,exit_code=7)}
        with patch('desk_companion.terminal.manager',return_value=Manager()):
            result=project.run('false; echo masked',self.config,'test')
        self.assertEqual(result['exit_code'],7)

    def test_command_delta_snapshots_skip_dependencies_and_record_real_text(self):
        (self.main/'node_modules').mkdir(); (self.main/'node_modules/large.js').write_text('skip')
        (self.main/'.env').write_text('SECRET')
        before,limited = project.source_snapshot(self.config)
        self.assertEqual(before,{'app.py':'value = 1\n'}); self.assertFalse(limited)


if __name__=='__main__': unittest.main()
