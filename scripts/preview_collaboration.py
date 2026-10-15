"""Create a two-hour, collaboration-only browser capability for the local dev client.

The backend's full bearer token is never returned. By default only the local
launch-file path is printed; use --open explicitly to launch a system browser.
"""
import argparse
import json
from pathlib import Path
import secrets
import sys
import time
from urllib.parse import quote

import psutil

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def pair():
    from desk_companion.collaboration_access import access_path
    candidates = []
    for process in psutil.process_iter(["name", "cmdline"]):
        try:
            args = process.info["cmdline"] or []
            if "desk_companion.local_api.server" in args and process.cwd().lower() == str(ROOT).lower():
                candidates.append(int(args[args.index("--port")+1]))
        except (psutil.Error, ValueError, IndexError):
            continue
    if len(candidates) != 1:
        raise RuntimeError("请先启动本仓库的桌面客户端，需要唯一的本地后端。")
    cap = secrets.token_urlsafe(36)
    path = access_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    expires = time.time()+7200
    path.write_text(json.dumps(dict(token=cap, expires=expires)), "utf-8")
    info = dict(port=candidates[0], token=cap)
    url = "http://127.0.0.1:5180/client.html?preview=chat&live=1#collaboration="+quote(json.dumps(info))
    launch = path.with_name("preview-launch.json")
    launch.write_text(json.dumps(dict(url=url, expires=expires)), "utf-8")
    return launch, url


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--open", action="store_true", help="显式打开系统浏览器")
    args = parser.parse_args()
    launch, url = pair()
    if args.open:
        import webbrowser
        webbrowser.open(url)
    print(json.dumps(dict(launch_file=str(launch), expires_in_seconds=7200), ensure_ascii=False))
