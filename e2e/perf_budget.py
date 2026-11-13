"""Performance budget on a throttled mid-range phone profile (Playwright + Chromium, local server).

Usage: python3 e2e/perf_budget.py        (run by the `perf` job in .github/workflows/e2e.yml; NOT part of run_all.py,
       because timing checks must not share a runner with the functional suites)
Env:   POC_PORT (default: a free port), POC_DIR, PERF_CPU (default 3), PERF_LATENCY_MS (default 40), PERF_DOWN_MBPS (default 12),
       PERF_RUNS (default 5), PERF_SCALE (multiply every budget; default 1, for slow local machines)

Profile: 390x800 touch viewport, CPU slowed 3x (Lighthouse uses 4x for low-end phones), 40 ms added round trip, 12 Mbit/s down, empty HTTP cache for every cold run.

Budgets (median of PERF_RUNS runs, so one noisy run does not fail the build):
  first interaction  < 1000 ms   cold start: navigation start until the app is ready for its first tap (data-ready, mark acct:ready)
  tap response       <  200 ms   the first tap (Search) until the command palette is on screen
  quick-sale submit  <  300 ms   tapping "Complete sale" until the confirmation note is on screen (POST + reload + render)
  app bytes          <  400 KB   JS + CSS + HTML downloaded by the cold start (uncompressed: the PoC server does not compress)
Timings are taken inside the page (performance.now, user-timing marks from public/core/), so Python and DevTools round trips
are not counted. Readiness comes from the app itself (data-ready, public/core/ready.js), never from a timer.
"""
import os, statistics, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from helpers import ready

HERE = os.path.dirname(os.path.abspath(__file__))
POC_DIR = os.environ.get("POC_DIR") or os.path.dirname(HERE)
def free_port():
    import socket
    with socket.socket() as so: so.bind(("127.0.0.1", 0)); return so.getsockname()[1]
PORT = os.environ.get("POC_PORT") or str(free_port())
BASE = f"http://127.0.0.1:{PORT}"
CPU = float(os.environ.get("PERF_CPU", "3"))
LATENCY = float(os.environ.get("PERF_LATENCY_MS", "40"))
DOWN = float(os.environ.get("PERF_DOWN_MBPS", "12"))
RUNS = int(os.environ.get("PERF_RUNS", "5"))
SCALE = float(os.environ.get("PERF_SCALE", "1"))
BUDGET_FIRST_MS, BUDGET_TAP_MS, BUDGET_SALE_MS, BUDGET_BYTES = 1000 * SCALE, 200 * SCALE, 300 * SCALE, 400 * 1024

server = subprocess.Popen(["node", "--no-warnings", "src/server.js"], cwd=POC_DIR, env={**os.environ, "PORT": PORT, "REQUEST_LOG": "0"})
for _ in range(300):  # up to 30 s: a busy CI runner can be slow to start node
    if server.poll() is not None: sys.exit(f"server exited with code {server.returncode} (is port {PORT} already in use?)")
    try: urllib.request.urlopen(f"{BASE}/api/demo-users", timeout=2); break
    except Exception: time.sleep(0.1)
else: sys.exit("server did not start")

problems = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: problems.append(msg)

# In-page timer: t0 at the capture-phase click on `trigger`, t1 when `target` first matches in the DOM.
OBSERVE = """([trigger, target, key]) => {
  window.__perf = window.__perf || {}; const r = (window.__perf[key] = {});
  document.addEventListener('click', (e) => { if (e.target.closest(trigger)) r.t0 = performance.now(); }, { capture: true, once: true });
  new MutationObserver((_, o) => { if (r.t0 && !r.t1 && document.querySelector(target)) { r.t1 = performance.now(); o.disconnect(); } })
    .observe(document.body, { childList: true, subtree: true });
}"""

def throttle(ctx, page):
    cdp = ctx.new_cdp_session(page)
    cdp.send("Emulation.setCPUThrottlingRate", {"rate": CPU})
    cdp.send("Network.enable")
    cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": LATENCY, "downloadThroughput": DOWN * 125000, "uploadThroughput": DOWN * 125000 / 3})
    cdp.send("Network.setCacheDisabled", {"cacheDisabled": True})
    return cdp

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        first, tap, sale, nbytes = [], [], [], []
        for run in range(RUNS):
            # service workers blocked: the first visit of a new user is the cold start we budget for
            ctx = b.new_context(viewport={"width": 390, "height": 800}, device_scale_factor=2, is_mobile=True, has_touch=True, service_workers="block")
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            throttle(ctx, page)

            page.goto(BASE + "/#/sales", wait_until="commit")
            ready(page, timeout=30000)
            page.wait_for_selector("input[data-sku]")
            first.append(page.evaluate("performance.getEntriesByName('acct:ready', 'mark')[0].startTime"))
            nbytes.append(page.evaluate("""() => performance.getEntriesByType('resource').filter((e) => !new URL(e.name).pathname.startsWith('/api/')).reduce((n, e) => n + e.transferSize, 0)
              + performance.getEntriesByType('navigation').reduce((n, e) => n + e.transferSize, 0)"""))

            # first tap: Search opens the command palette
            page.evaluate(OBSERVE, ["#search", "[role=dialog] input[role=combobox]", "tap"])
            page.click("#search")
            page.wait_for_selector("[role=dialog] input[role=combobox]")
            tap.append(page.evaluate("window.__perf.tap.t1 - window.__perf.tap.t0"))
            page.keyboard.press("Escape")

            # quick sale submit
            qty = page.locator("input[data-sku]").first
            qty.fill("1"); qty.dispatch_event("input")
            page.evaluate(OBSERVE, ["[data-act=sale]", "#main .note.good, #main .note.warn, #main .note.bad", "sale"])
            page.click("button[data-act=sale]")
            page.wait_for_selector("#main .note.good, #main .note.warn")
            ready(page)
            sale.append(page.evaluate("window.__perf.sale.t1 - window.__perf.sale.t0"))
            check(not errors, f"run {run + 1}: no page errors {errors[:2]}")
            ctx.close()

        mf, mt, ms, mb = statistics.median(first), statistics.median(tap), statistics.median(sale), statistics.median(nbytes)
        print(f"profile: cpu x{CPU}, +{LATENCY:.0f} ms RTT, {DOWN:.0f} Mbit/s, {RUNS} runs")
        print(f"first interaction: median {mf:.0f} ms (runs {[round(x) for x in first]})")
        print(f"tap response:      median {mt:.0f} ms (runs {[round(x) for x in tap]})")
        print(f"quick-sale submit: median {ms:.0f} ms (runs {[round(x) for x in sale]})")
        print(f"app bytes:         median {mb / 1024:.0f} KB")
        check(mf < BUDGET_FIRST_MS, f"first interaction {mf:.0f} ms < {BUDGET_FIRST_MS:.0f} ms")
        check(mt < BUDGET_TAP_MS, f"tap response {mt:.0f} ms < {BUDGET_TAP_MS:.0f} ms")
        check(ms < BUDGET_SALE_MS, f"quick-sale submit {ms:.0f} ms < {BUDGET_SALE_MS:.0f} ms")
        check(mb < BUDGET_BYTES, f"app bytes {mb / 1024:.0f} KB < {BUDGET_BYTES // 1024} KB")
        b.close()
finally:
    server.terminate(); server.wait()
print("\nPERFORMANCE BUDGET MET" if not problems else f"\nBUDGET EXCEEDED: {problems}")
sys.exit(1 if problems else 0)
