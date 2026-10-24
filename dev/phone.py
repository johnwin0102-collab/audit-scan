"""Drives the app on John's phone from this PC, over USB (adb) and Chrome's DevTools protocol.

usage: phone.py connect [port]        adb forward (DevTools on localhost:9222) and adb reverse (the phone's localhost:port
                                      reaches recserve.py on this PC; default 8000)
       phone.py pages                 the pages open in Chrome on the phone
       phone.py open [url]            opens a tab (default http://localhost:8000/, the copy served by recserve.py)
       phone.py eval "<js>" [--page s] evaluates in the page whose address contains s (default: localhost)
       phone.py evalf <file.js>       the same, with the expression in a file (e.g. phone_watch.js)
       phone.py status [--page s]     version, screen, camera, outline speed
       phone.py rec <name> | stop     starts / stops recording the live worker's frames (only works on the localhost copy)
       phone.py shot <out.png>        a screenshot of the phone's screen

Recordings show John's real documents: they go to dev/videos/ (ignored by git) and never into the repository."""
import json, os, shutil, subprocess, sys, urllib.request

import websocket

ADB = shutil.which("adb") or os.path.expandvars(
    r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe")
DEVTOOLS = "http://localhost:9222"


def adb(*a, **kw):
    return subprocess.run([ADB, *a], capture_output=True, **kw)


def pages():
    return [p for p in json.load(urllib.request.urlopen(DEVTOOLS + "/json")) if p.get("type") == "page"]


def evaluate(expr, page="localhost", timeout=60):
    ps = [p for p in pages() if page in p.get("url", "")]
    if not ps:
        # (only the app's pages are named: John's other tabs are none of our business)
        raise SystemExit(f"no page with '{page}' in its address; the app's pages: " +
                         (", ".join(p["url"] for p in pages() if "localhost" in p["url"] or "audit-scan" in p["url"]) or "none"))
    ws = websocket.create_connection(ps[0]["webSocketDebuggerUrl"], timeout=timeout, suppress_origin=True)
    try:
        ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                            "params": {"expression": expr, "awaitPromise": True, "returnByValue": True}}))
        while True:
            m = json.loads(ws.recv())
            if m.get("id") == 1:
                r = m.get("result", {})
                if "exceptionDetails" in r:
                    d = r["exceptionDetails"]
                    raise RuntimeError((d.get("exception") or {}).get("description") or d.get("text"))
                return r.get("result", {}).get("value")
    finally:
        ws.close()


STATUS = """(() => { const a = window.__auditScan; if (!a) return { href: location.href, app: false };
  return { href: location.href, version: (document.getElementById("verText") || {}).textContent, screen: a.S.screen,
    hidden: document.hidden, camera: a.cam.res, camFps: a.cam.fps, synced: a.cam.synced, path: a.tracker.path,
    stats: a.stats }; })()"""


def main():
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    page = "localhost"
    if "--page" in a:
        i = a.index("--page"); page = a[i + 1]; del a[i:i + 2]
    cmd = a[0]
    if cmd == "connect":
        port = a[1] if len(a) > 1 else "8000"
        print(adb("devices").stdout.decode().strip())
        adb("forward", "tcp:9222", "localabstract:chrome_devtools_remote")
        adb("reverse", f"tcp:{port}", f"tcp:{port}")
        print(json.load(urllib.request.urlopen(DEVTOOLS + "/json/version"))["Browser"])
    elif cmd == "pages":
        # (only the app's pages: John's other tabs are none of our business)
        for p in pages():
            if "localhost" in p["url"] or "audit-scan" in p["url"]:
                print(p["id"], p["url"], p.get("title", ""))
    elif cmd == "open":
        url = a[1] if len(a) > 1 else "http://localhost:8000/"
        req = urllib.request.Request(DEVTOOLS + "/json/new?" + url, method="PUT")
        print(json.load(urllib.request.urlopen(req))["url"])
    elif cmd == "eval":
        print(json.dumps(evaluate(a[1], page), indent=1))
    elif cmd == "evalf":
        print(json.dumps(evaluate(open(a[1], encoding="utf8").read(), page, timeout=600)))
    elif cmd == "status":
        print(json.dumps(evaluate(STATUS, page), indent=1))
    elif cmd in ("rec", "stop"):
        name = a[1] if cmd == "rec" else ""
        print(evaluate(f"""(() => {{ const w = window.__auditScan && window.__auditScan.tracker.worker;
          if (!w) return "no live worker yet: open the camera first";
          w.postMessage({{ type: "debug", rec: {json.dumps(name)} }}); return {json.dumps(name)} ? "recording" : "stopped"; }})()""", page))
    elif cmd == "shot":
        png = adb("exec-out", "screencap", "-p").stdout
        open(a[1], "wb").write(png)
        print(a[1], len(png), "bytes")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
