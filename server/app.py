"""Chaos Tracker — a tiny incident log that shows off htmx 2.x.

Every interactive bit of the UI is driven by htmx attributes; the server
only ever returns HTML (full pages or fragments). Storage is in-memory.
"""
import json
import queue
import random
import threading
import time
from datetime import datetime, timedelta

from flask import Flask, Response, abort, render_template, request

app = Flask(__name__)

SEVERITIES = ["low", "medium", "high", "critical"]
SEV_WEIGHT = {"low": 1, "medium": 2, "high": 4, "critical": 8}
SEV_EMOJI = {"low": "🟢", "medium": "🟡", "high": "🟠", "critical": "🔴"}
CATEGORIES = ["infra", "code", "people", "office", "cosmic"]
STATUSES = ["open", "mitigating", "resolved"]
NEXT_STATUS = {"open": "mitigating", "mitigating": "resolved", "resolved": "open"}
PAGE_SIZE = 6

_lock = threading.Lock()
_events = {}  # id -> dict
_next_id = 1
_monkey = {"on": False}
_subscribers = []  # list[queue.Queue] for SSE clients

SEED = [
    ("Prod DB replaced with a CSV someone opened in Excel", "infra", "critical", "open",
     "Leading zeros are gone. So are the customer IDs."),
    ("Intern discovered `rm -rf` has no undo", "people", "high", "mitigating",
     "Backups exist. Probably. Somebody check."),
    ("Coffee machine returned HTTP 418", "office", "medium", "open",
     "It is, in fact, a teapot. Morale dropping."),
    ("DNS. It was DNS.", "infra", "high", "resolved", "It's always DNS."),
    ("Cosmic ray flipped a feature flag", "cosmic", "low", "open",
     "Dark mode now only works on Tuesdays."),
    ("Friday 4:59pm deploy", "code", "critical", "mitigating",
     "Merged with the message 'should be fine'."),
    ("Regex now matches the entire universe", "code", "medium", "open",
     ".* was a choice."),
    ("Slack status set to 'on fire' (literally)", "office", "low", "resolved",
     "Toaster incident. Fire marshal has been looped in."),
]

MONKEY_TITLES = [
    "Load balancer is balancing nothing", "CI went green for no reason (suspicious)",
    "Kubernetes pod achieved sentience", "Cache invalidation, again",
    "Timezone bug only affects leap seconds", "Printer is printing in Wingdings",
    "Someone pushed node_modules", "TLS cert expired 3 minutes ago",
    "Off-by-one error in the off-by-one fix", "Wi-Fi only works when standing on one leg",
    "The cloud is just raining now", "Mercury in retrograde (blamed in postmortem)",
    "Dependency left-pad'd itself", "Tabs vs spaces war broke out in #general",
]


def _add(title, category, severity, status="open", description="", created=None):
    global _next_id
    with _lock:
        ev = dict(id=_next_id, title=title, category=category, severity=severity,
                  status=status, description=description,
                  created=created or datetime.now())
        _events[_next_id] = ev
        _next_id += 1
        # keep memory bounded if the chaos monkey runs all night
        if len(_events) > 500:
            del _events[min(_events)]
        return ev


def seed():
    now = datetime.now()
    for i, (t, c, s, st, d) in enumerate(SEED):
        _add(t, c, s, st, d, created=now - timedelta(minutes=17 * (len(SEED) - i)))


def get_event(eid):
    ev = _events.get(eid)
    if not ev:
        abort(404)
    return ev


def filtered(q="", severity="", status="", before=None):
    q = (q or "").strip().lower()
    out = sorted(_events.values(), key=lambda e: e["id"], reverse=True)
    if q:
        out = [e for e in out if q in e["title"].lower() or q in e["description"].lower()
               or q in e["category"]]
    if severity:
        out = [e for e in out if e["severity"] == severity]
    if status:
        out = [e for e in out if e["status"] == status]
    if before:
        out = [e for e in out if e["id"] < before]
    return out


def stats():
    evs = list(_events.values())
    by_status = {s: sum(1 for e in evs if e["status"] == s) for s in STATUSES}
    by_sev = {s: sum(1 for e in evs if e["severity"] == s and e["status"] != "resolved")
              for s in SEVERITIES}
    score = sum(SEV_WEIGHT[e["severity"]] * (1 if e["status"] == "open" else 0.5)
                for e in evs if e["status"] != "resolved")
    level = min(100, int(score * 2.5))
    if level < 20:
        mood = "Suspiciously calm 🧘"
    elif level < 45:
        mood = "Mildly spicy 🌶️"
    elif level < 75:
        mood = "Things are on fire 🔥"
    else:
        mood = "Total meltdown ☢️"
    return dict(total=len(evs), by_status=by_status, by_sev=by_sev, level=level, mood=mood,
                now=datetime.now().strftime("%H:%M:%S"), monkey=_monkey["on"])


def filter_args():
    a = request.args
    return dict(q=a.get("q", ""), severity=a.get("severity", ""), status=a.get("status", ""))


def page(**f):
    before = request.args.get("before", type=int)
    rows = filtered(before=before, **f)
    return rows[:PAGE_SIZE], (rows[PAGE_SIZE - 1]["id"] if len(rows) > PAGE_SIZE else None)


def is_htmx():
    return request.headers.get("HX-Request") == "true" and \
        request.headers.get("HX-History-Restore-Request") != "true"


def ctx(**kw):
    return dict(SEVERITIES=SEVERITIES, CATEGORIES=CATEGORIES, STATUSES=STATUSES,
                SEV_EMOJI=SEV_EMOJI, NEXT_STATUS=NEXT_STATUS, **kw)


def toast(resp_headers, message, level="info", **extra):
    payload = {"showToast": {"message": message, "level": level}}
    payload.update(extra)
    resp_headers["HX-Trigger"] = json.dumps(payload)


app.jinja_env.globals.update(SEV_EMOJI=SEV_EMOJI, NEXT_STATUS=NEXT_STATUS,
                             SEVERITIES=SEVERITIES, CATEGORIES=CATEGORIES, STATUSES=STATUSES)
app.jinja_env.filters["ago"] = lambda d: (
    "just now" if (s := int((datetime.now() - d).total_seconds())) < 60
    else f"{s // 60}m ago" if s < 3600 else f"{s // 3600}h ago")


# ---------------------------------------------------------------- pages
@app.get("/")
def index(detail=None):
    f = filter_args()
    rows, next_before = page(**f)
    return render_template("index.html", rows=rows, next_before=next_before, f=f,
                           stats=stats(), detail=detail)


@app.get("/favicon.ico")
def favicon():
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌀</text></svg>'
    return svg, 200, {"Content-Type": "image/svg+xml"}


@app.get("/about")
def about():
    return render_template("about.html", stats=stats())


# ---------------------------------------------------------------- list / search / paging
@app.get("/events")
def list_events():
    f = filter_args()
    rows, next_before = page(**f)
    if request.args.get("q") is not None and not request.args.get("before"):
        time.sleep(0.25)  # make the hx-indicator spinner visible in the demo
    html = render_template("_rows.html", rows=rows, next_before=next_before, f=f)
    headers = {}
    if not request.args.get("before"):
        # Keep the address bar in sync with the filters (HX-Push-Url response header)
        qs = "&".join(f"{k}={v}" for k, v in f.items() if v)
        headers["HX-Push-Url"] = "/" + (f"?{qs}" if qs else "")
    return html, 200, headers


# ---------------------------------------------------------------- create
@app.post("/events")
def create_event():
    form = request.form
    title = form.get("title", "").strip()
    severity = form.get("severity", "medium")
    category = form.get("category", "code")
    errors = []
    if len(title) < 3:
        errors.append("Give the chaos a title (3+ characters). Chaos deserves a name.")
    if severity not in SEVERITIES:
        errors.append("Unknown severity.")
    if category not in CATEGORIES:
        errors.append("Unknown category.")
    if errors:
        # Redirect the swap somewhere else entirely (HX-Retarget / HX-Reswap)
        return render_template("_form_errors.html", errors=errors), 200, {
            "HX-Retarget": "#form-errors", "HX-Reswap": "innerHTML"}
    ev = _add(title, category, severity, "open", form.get("description", "").strip())
    headers = {}
    toast(headers, f"{SEV_EMOJI[severity]} Logged: {title}", "success", **{"chaos-logged": True})
    return render_template("_row.html", e=ev, fresh=True) + oob_bundle(), 200, headers


@app.post("/events/random")
def random_event():
    ev = monkey_event()
    headers = {}
    toast(headers, f"🐒 Random chaos: {ev['title']}", "warn")
    return render_template("_row.html", e=ev, fresh=True) + oob_bundle(), 200, headers


def oob_bundle():
    """Fragments piggy-backed on another response via hx-swap-oob."""
    return (render_template("_counter.html", total=len(_events), oob=True) +
            render_template("_stats.html", stats=stats(), oob=True) +
            '<div id="form-errors" hx-swap-oob="innerHTML"></div>')


# ---------------------------------------------------------------- row ops
@app.get("/events/<int:eid>")
def detail(eid):
    ev = get_event(eid)
    if is_htmx():
        return render_template("_detail.html", e=ev)
    return index(detail=ev)  # deep link / refresh: full page with drawer open


@app.get("/events/<int:eid>/row")
def row(eid):
    return render_template("_row.html", e=get_event(eid))


@app.get("/events/<int:eid>/edit")
def edit(eid):
    return render_template("_edit_row.html", e=get_event(eid))


@app.put("/events/<int:eid>")
def update(eid):
    ev = get_event(eid)
    title = request.form.get("title", "").strip()
    if len(title) < 3:
        return render_template("_edit_row.html", e=ev, error="Title needs 3+ characters",
                               draft=request.form)
    with _lock:
        ev["title"] = title
        if request.form.get("severity") in SEVERITIES:
            ev["severity"] = request.form["severity"]
        if request.form.get("category") in CATEGORIES:
            ev["category"] = request.form["category"]
    headers = {}
    toast(headers, f"✏️ Updated #{eid}", "info")
    return render_template("_row.html", e=ev, fresh=True) + oob_bundle(), 200, headers


@app.patch("/events/<int:eid>/status")
def advance(eid):
    ev = get_event(eid)
    with _lock:
        ev["status"] = request.form.get("status") if request.form.get("status") in STATUSES \
            else NEXT_STATUS[ev["status"]]
    msg = {"open": "😱 Re-opened", "mitigating": "🧯 Mitigating", "resolved": "✅ Resolved"}
    headers = {}
    toast(headers, f"{msg[ev['status']]}: {ev['title']}",
          "success" if ev["status"] == "resolved" else "info")
    return render_template("_row.html", e=ev, fresh=True) + oob_bundle(), 200, headers


@app.delete("/events/<int:eid>")
def delete(eid):
    ev = get_event(eid)
    with _lock:
        _events.pop(eid, None)
    headers = {}
    toast(headers, f"🗑️ Swept under the rug: {ev['title']}", "warn")
    # empty main body => the row is removed (after the swap:500ms fade); OOB updates stats
    return oob_bundle(), 200, headers


# ---------------------------------------------------------------- stats polling
@app.get("/stats")
def stats_panel():
    # OOB counter keeps the header in sync with rows the chaos monkey pushed over SSE
    return render_template("_stats.html", stats=stats()) + \
        render_template("_counter.html", total=len(_events), oob=True)


# ---------------------------------------------------------------- chaos monkey + SSE
def monkey_event():
    sev = random.choices(SEVERITIES, weights=[3, 4, 3, 1])[0]
    return _add(random.choice(MONKEY_TITLES), random.choice(CATEGORIES), sev, "open",
                "Generated by the chaos monkey 🐒")


def broadcast(event, data):
    msg = f"event: {event}\n" + "".join(f"data: {line}\n" for line in data.splitlines()) + "\n"
    for q in list(_subscribers):
        q.put(msg)


def monkey_loop():
    while True:
        time.sleep(random.uniform(2.5, 4.5))
        if not _monkey["on"]:
            continue
        ev = monkey_event()
        with app.app_context():
            broadcast("chaos", render_template("_row.html", e=ev, fresh=True))
            broadcast("ticker", render_template("_ticker.html", e=ev))


@app.post("/monkey")
def toggle_monkey():
    _monkey["on"] = not _monkey["on"]
    headers = {}
    toast(headers, "🐒 Chaos monkey UNLEASHED" if _monkey["on"] else "🐒 Chaos monkey back in its cage",
          "warn" if _monkey["on"] else "info")
    return render_template("_monkey.html", on=_monkey["on"]), 200, headers


@app.get("/stream")
def stream():
    q = queue.Queue()
    _subscribers.append(q)

    def gen():
        try:
            yield ": connected\n\n"
            while True:
                try:
                    yield q.get(timeout=15)
                except queue.Empty:
                    yield ": keep-alive\n\n"
        finally:
            _subscribers.remove(q)

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


seed()
threading.Thread(target=monkey_loop, daemon=True).start()

if __name__ == "__main__":
    import os
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)), threaded=True, debug=False)
