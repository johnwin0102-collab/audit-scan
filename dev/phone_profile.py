"""Profiles the live outline worker on the phone for a few seconds (Chrome DevTools protocol, phone.py connect first)
and prints where its time goes: phone_profile.py [seconds] [--page localhost]"""
import collections, json, sys, time, urllib.request
import websocket

secs = float(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else 5
page = sys.argv[sys.argv.index("--page") + 1] if "--page" in sys.argv else "localhost"
targets = json.load(urllib.request.urlopen("http://localhost:9222/json"))


pg = [t for t in targets if t.get("type") == "page" and page in t.get("url", "")][0]
ws = websocket.create_connection(pg["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
seq = [0]


def call(method, params=None, session=None):
    seq[0] += 1
    m = {"id": seq[0], "method": method, "params": params or {}}
    if session: m["sessionId"] = session
    ws.send(json.dumps(m))
    while True:
        r = json.loads(ws.recv())
        if r.get("method") == "Target.attachedToTarget": sessions.append(r["params"])
        if r.get("id") == seq[0]:
            return r.get("result", {})


# (the page's workers, attached through the page: their own DevTools addresses don't answer on Android)
sessions = []
call("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": False, "flatten": True})
live = None
for a in sessions:
    href = call("Runtime.evaluate", {"expression": "self.location.href", "returnByValue": True}, a["sessionId"]).get("result", {}).get("value", "")
    if href.endswith("live-worker.js"): live = a["sessionId"]
if not live: sys.exit("live worker not found: " + ", ".join(a["targetInfo"].get("url", "") for a in sessions))
call("Profiler.enable", None, live)
call("Profiler.setSamplingInterval", {"interval": 200}, live)
call("Profiler.start", None, live)
time.sleep(secs)
prof = call("Profiler.stop", None, live)["profile"]
call("Target.setAutoAttach", {"autoAttach": False, "waitForDebuggerOnStart": False, "flatten": True})
nodes = {n["id"]: n for n in prof["nodes"]}
parent = {}
for n in prof["nodes"]:
    for c in n.get("children", []): parent[c] = n["id"]
dts = prof["timeDeltas"]
self_t, total_t = collections.Counter(), collections.Counter()
for sid, dt in zip(prof["samples"], dts):
    n = nodes[sid]
    name = n["callFrame"]["functionName"] or "(anon)"
    self_t[name] += dt
    seen, cur = set(), sid
    while cur is not None:
        nm = nodes[cur]["callFrame"]["functionName"] or "(anon)"
        if nm not in seen: total_t[nm] += dt; seen.add(nm)
        cur = parent.get(cur)
span = sum(dts)
print(f"{span / 1e3:.0f} ms sampled")
print("self time:")
for k, v in self_t.most_common(18): print(f"  {k:28} {100 * v / span:5.1f}%")
print("total (inclusive):")
for k, v in total_t.most_common(22): print(f"  {k:28} {100 * v / span:5.1f}%")
