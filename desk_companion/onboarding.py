"""首次配置状态，仅返回配置是否存在，不读取外部账号或返回密钥。"""
import importlib.util
import json
import shutil

from .paths import asset_root, data_root
from .model_catalog import public_catalog


def status() -> dict:
    root = data_root()
    path = root / "onboarding.json"
    saved = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    models = public_catalog()
    return {
        "ok": True,
        "show": not models["items"] or (bool(saved) and not saved.get("completed")),
        "data_dir": str(root),
        "assets_dir": str(asset_root()),
        "configured": bool(models["items"]),
        "checks": {
            "github": shutil.which("gh") is not None,
            "feishu": shutil.which("lark-cli") is not None,
            "knowledge": importlib.util.find_spec("sentence_transformers") is not None,
            "pet": True,  # The vector pet is included with every client.
            "live2d": (asset_root() / "Core/live2dcubismcore.js").is_file()
                and (asset_root() / "skins/kaltsit/kaltsit.model3.json").is_file(),
        },
    }


def complete() -> dict:
    (data_root() / "onboarding.json").write_text(
        json.dumps({"version": 1, "completed": True}) + "\n", encoding="utf-8"
    )
    return {"ok": True}
