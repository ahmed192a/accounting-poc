import subprocess, time, sys, os, json, urllib.request
from playwright.sync_api import sync_playwright

# Smoke test: sign in as each demo user, visit every navigation page we can discover, and fail on
#   - any console error or uncaught page error
#   - any failed request (network failure, 5xx, or a 4xx other than the allowed refusals below)
#   - an empty page
# Navigation is discovered from the DOM (tabs / nav links / [data-page]); with none, only the home page is visited.
# Usage: python3 e2e/smoke_all_modules.py
# Env: POC_DIR (repo, default: this script's repo), POC_PORT (default 3100), POC_SHOTS (default <repo>/e2e/shots)
HERE = os.path.dirname(os.path.abspath(__file__))
POC_DIR = os.environ.get("POC_DIR") or os.path.dirname(HERE)
PORT = os.environ.get("POC_PORT", "3100")
OUT = os.environ.get("POC_SHOTS") or os.path.join(HERE, "shots")
BASE = f"http://127.0.0.1:{PORT}"
# 4xx statuses that are legitimate refusals on /api/ (validation, permission, conflict); static files must never 4xx
ALLOWED_4XX = {400, 403, 409, 422}
# tried in order; the first selector that yields at least one visible item wins
NAV_SELECTORS = ["[role=tab]", "[data-page]", "nav a", "nav button", ".tabs button", ".tabs a", ".nav button", ".nav a"]
os.makedirs(OUT, exist_ok=True)

server = subprocess.Popen(["node", "--no-warnings", "src/server.js"], cwd=POC_DIR, env={**os.environ, "PORT": PORT})
up = False
for _ in range(100):
    try:
        urllib.request.urlopen(f"{BASE}/healthz"); up = True; break
    except Exception:
        time.sleep(0.1)

problems = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: problems.append(msg)

def discover_nav(page):
    """Return (selector, [labels]) for the first selector with visible items, or (None, [])."""
    for sel in NAV_SELECTORS:
        loc = page.locator(sel)
        labels = []
        for i in range(loc.count()):
            el = loc.nth(i)
            if not el.is_visible(): continue
            label = (el.inner_text() or el.get_attribute("aria-label") or el.get_attribute("data-page") or "").strip()
            if label and label not in labels: labels.append(label)
        if labels: return sel, labels
    return None, []

try:
    check(up, "server started")
    users = json.load(urllib.request.urlopen(f"{BASE}/api/demo-users")) if up else []
    check(len(users) == 6, f"six demo users listed (got {len(users)})")
    with sync_playwright() as p:
        b = p.chromium.launch()
        for u in users:
            page = b.new_page(viewport={"width": 1280, "height": 900})
            issues = []
            tag = u['name']
            def on_console(m, issues=issues):
                if m.type != "error": return
                # the browser logs a console error for every 4xx; those are judged by on_response instead
                if m.text.startswith("Failed to load resource") and any(f"status of {c}" in m.text for c in ALLOWED_4XX): return
                issues.append(f"console error: {m.text}")
            def on_response(r, issues=issues):
                s = r.status
                if s >= 500: issues.append(f"HTTP {s} {r.request.method} {r.url}")
                elif s >= 400 and not (s in ALLOWED_4XX and "/api/" in r.url): issues.append(f"HTTP {s} {r.request.method} {r.url}")
            page.on("console", on_console)
            page.on("pageerror", lambda e, issues=issues: issues.append(f"page error: {e}"))
            page.on("response", on_response)
            page.on("requestfailed", lambda r, issues=issues: issues.append(f"request failed: {r.url} {r.failure}"))

            page.goto(BASE + "/")
            page.wait_for_selector("#user option", state="attached")
            page.select_option("#user", str(u["id"]))
            page.wait_for_load_state("networkidle")
            page.wait_for_selector(".role-line", timeout=10000)

            sel, labels = discover_nav(page)
            visited = ["home"] if not labels else []
            def visit(name, shot):
                page.wait_for_load_state("networkidle")
                text = page.inner_text("main").strip()
                if len(text) < 5: issues.append(f"empty page: {name}")
                page.screenshot(path=os.path.join(OUT, f"smoke_{u['id']}_{shot}.png"), full_page=True)
            if not labels:
                visit("home", "home")
            else:
                for i, label in enumerate(labels):
                    # nav is re-rendered after clicks, so find the item again by its label every time
                    page.locator(sel).filter(has_text=label).first.click()
                    visit(label, f"{i}")
                    visited.append(label)
            check(not issues, f"{tag}: {len(visited)} page(s) {visited}" + (" clean" if not issues else " PROBLEMS: " + "; ".join(issues[:5])))
            page.close()
        b.close()
finally:
    server.terminate()

print("\nFAILED:" if problems else "\nALL SMOKE CHECKS PASSED", problems or "")
sys.exit(1 if problems else 0)
