import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from desk_companion import pet_preferences as pets


class PetPreferencesTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        env = patch.dict(os.environ, {'DESK_COMPANION_DATA_DIR': temp.name,
                                     'DESK_COMPANION_ASSET_DIR': str(self.root / 'assets')})
        env.start(); self.addCleanup(env.stop)

    def test_default_has_no_live2d_dependency_and_saved_skin_survives_reload(self):
        self.assertEqual(pets.load()['skin'], 'paper')
        self.assertFalse(pets.load()['live2d_available'])
        pets.save('sage')
        self.assertEqual(pets.load()['skin'], 'sage')
        self.assertTrue((self.root / 'memory/pet-preferences.json').exists())

    def test_invalid_skin_and_missing_live2d_do_not_replace_saved_selection(self):
        pets.save('ink')
        for skin in ('../../file', '<script>', 'kaltsit', [], None):
            with self.subTest(skin=skin), self.assertRaises(ValueError): pets.save(skin)
        self.assertEqual(pets.load()['skin'], 'ink')

    def test_existing_model_can_be_selected_without_changing_agent_persona(self):
        assets = self.root / 'assets'
        for relative in ('Core/live2dcubismcore.js', 'skins/kaltsit/kaltsit.model3.json'):
            path = assets / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('{}')
        persona = self.root / 'persona.md'; persona.write_text('existing persona', 'utf-8')
        self.assertEqual(pets.save('kaltsit')['skin'], 'kaltsit')
        self.assertTrue(pets.load()['live2d_available'])
        self.assertEqual(persona.read_text('utf-8'), 'existing persona')
