import base64
import unittest
from unittest.mock import patch
from desk_companion import github_repository as repo


class RepositoryTests(unittest.TestCase):
    def setUp(self): repo._tree.cache_clear()

    def api(self, endpoint):
        if '/git/trees/' in endpoint:
            return dict(tree=[dict(path='README.md',mode='100644',sha='file-sha')])
        if '/contents/' in endpoint or '/readme?' in endpoint:
            return dict(type='file',encoding='base64',path='README.md',size=30,sha='file-sha',content=base64.b64encode(b'# Atlas\nActual source text').decode())
        return dict(private=True,default_branch='main',description='framework',license=None)

    def test_owned_private_repo_read_uses_authenticated_api_and_real_source_receipt(self):
        with patch.object(repo,'resolve_repo',return_value='owner/Atlas'), patch.object(repo,'list_owned_repos',return_value=[dict(full_name='owner/Atlas')]),patch.object(repo,'_api',side_effect=self.api) as api:
            result=repo.read_repository(dict(operation='readme',repo='Atlas',offset=2,limit=10))
            self.assertEqual(result['text'],'Atlas\nActu');self.assertTrue(result['truncated'])
            self.assertEqual(result['next_offset'],12);self.assertEqual(result['sha'],'file-sha')
            self.assertEqual(result['source']['level'],'body');self.assertIn('/blob/main/README.md',result['url'])
            self.assertTrue(any('/readme?' in c.args[0] for c in api.call_args_list))

    def test_rejects_other_private_repos_traversal_credential_files_and_symlinks(self):
        with patch.object(repo,'_api',side_effect=self.api),patch.object(repo,'list_owned_repos',return_value=[]):
            with self.assertRaisesRegex(ValueError,'账号仓库范围'):repo.read_repository(dict(operation='read',repo='other/private',path='README.md'))
        for path in ['../a','/a','a/../b','.env','.env.production','models.json','key.pem','a\\b']:
            with self.subTest(path=path),self.assertRaises(ValueError):repo._path(path)
        with patch.object(repo,'_tree',return_value=[dict(path='README.md',mode='120000',sha='file-sha')]):
            with self.assertRaisesRegex(ValueError,'链接'):repo._file_entry('owner/repo','main','README.md')

    def test_discover_does_not_need_a_workspace_or_clone_and_all_api_calls_are_get(self):
        with patch.object(repo,'list_owned_repos',return_value=[dict(full_name='owner/Atlas')]):
            self.assertEqual(repo.read_repository(dict(operation='discover'))['repositories'][0]['full_name'],'owner/Atlas')
        with patch.object(repo,'_run_gh_json',return_value={}) as call:
            repo._api('repos/owner/repo');self.assertEqual(call.call_args.args[0][:6],['api','--hostname','github.com','--method','GET','repos/owner/repo'])
