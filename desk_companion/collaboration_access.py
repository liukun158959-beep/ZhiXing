"""Optional expiring browser capability, restricted to the collaboration RPCs."""
import hmac
import json
import time
from .paths import data_root


def access_path():
    return data_root() / "memory" / "collaboration" / "preview-access.json"


def preview_allowed(token, origin):
    if origin not in {"http://127.0.0.1:5180", "http://localhost:5180"}:
        return False
    try:
        access = json.loads(access_path().read_text("utf-8"))
        return (isinstance(token, str) and len(token) >= 32 and time.time() < float(access["expires"]) and
                hmac.compare_digest(token.encode(), access["token"].encode()))
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return False
