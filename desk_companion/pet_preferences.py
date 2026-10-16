"""Persist the optional pet appearance independently of agent identity."""
import json

from .paths import asset_root, data_root
from .resource_lock import ResourceLock
from .video import atomic_write

LOCK = ResourceLock('pet-preferences')
SKINS = ('paper', 'sage', 'ink', 'kaltsit')


def available_live2d():
    return (asset_root() / 'Core/live2dcubismcore.js').is_file() and (asset_root() / 'skins/kaltsit/kaltsit.model3.json').is_file()


def load():
    with LOCK:
        path = data_root() / 'memory/pet-preferences.json'
        saved = json.loads(path.read_text('utf-8')) if path.exists() else {}
        skin = saved.get('skin', 'paper')
        return dict(ok=True, skin=skin if skin in SKINS else 'paper', size=saved.get('size', 48) if type(saved.get('size',48)) is int and 32 <= saved.get('size',48) <= 64 else 48, live2d_available=available_live2d())


def save(skin, size=None):
    if not isinstance(skin, str) or skin not in SKINS:
        raise ValueError('未知桌宠皮肤')
    if skin == 'kaltsit' and not available_live2d():
        raise ValueError('凯尔希素材尚未就绪，请在使用引导中查看素材位置；内置形象可直接使用。')
    with LOCK:
        current = load()
        size = current['size'] if size is None else size
        if type(size) is not int or not 32 <= size <= 64: raise ValueError('圆形桌宠大小须为 32～64px')
        atomic_write(data_root() / 'memory/pet-preferences.json', dict(skin=skin, size=size))
    return load()
