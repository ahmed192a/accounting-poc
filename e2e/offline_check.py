import subprocess, time, sys, os, json, urllib.request
from playwright.sync_api import sync_playwright

# Usage: python3 e2e/offline_check.py     Env: POC_PORT (default 3201), POC_SHOTS (default /tmp/offline-shots)
# Goes offline, sells, comes back, checks the sale reached the server exactly once; then a conflict (item deactivated while offline).
HERE = os.path.dirname(os.path.abspath(__file__))
POC_DIR = os.environ.get("POC_DIR") or os.path.dirname(HERE)
PORT = os.environ.get("POC_PORT", "3201")
OUT = os.environ.get("POC_SHOTS") or "/tmp/offline-shots"
os.makedirs(OUT, exist_ok=True)
BASE = f"http://127.0.0.1:{PORT}"
server = subprocess.Popen(["node", "--no-warnings", "src/server.js"], cwd=POC_DIR, env={**os.environ, "PORT": PORT, "REQUEST_LOG": "0"})
for _ in range(50):
    try: urllib.request.urlopen(f"{BASE}/api/demo-users"); break
    except Exception: time.sleep(0.1)

def api(method, path, uid, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"x-user-id": str(uid), "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e: return {"error": json.loads(e.read() or b"{}"), "status": e.code}

problems = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: problems.append(msg)

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1280, "height": 900}, bypass_csp=True)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "/#/sales")
        page.wait_for_selector("input[data-sku]", timeout=10000)
        # wait until the worker controls the page and /api/home is in the API cache
        page.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller", timeout=10000)
        page.reload(); page.wait_for_selector("input[data-sku]")
        page.wait_for_function("""async () => { const c = await caches.open('acct-api-v1'); return (await c.keys()).some(r => r.url.includes('/api/home')); }""", timeout=10000)
        check(True, "service worker active and /api/home cached")
        items = api("GET", "/api/items", 3)
        skus = [i["sku"] for i in items]
        sales_before = len(api("GET", "/api/sales", 3))

        # ---- offline: reload (shell + cached data), sell ----
        ctx.set_offline(True)
        page.reload(); page.wait_for_selector("input[data-sku]", timeout=10000)
        check("offline" in page.inner_text("#banner").lower() and "saved on this device" in page.inner_text("#banner").lower(), "banner states what works offline")
        check(page.locator("#banner").is_visible(), "offline banner visible")
        qty = page.locator("input[data-sku]").first
        sku0 = qty.get_attribute("data-sku")
        qty.fill("2"); qty.dispatch_event("input")
        page.click("button[data-act=sale]")
        page.wait_for_selector("#offline-chip", timeout=5000)
        check("1 pending" in page.inner_text("#offline-chip"), "header shows 1 pending")
        check("queued" in page.inner_text(".note").lower(), "sale screen shows receipt Queued while offline")
        check(len(api("GET", "/api/sales", 3)) == sales_before, "server has NOT received the sale yet")
        page.screenshot(path=f"{OUT}/1_offline_queued.png")
        page.goto(BASE + "/#/offline"); page.wait_for_selector("#offline-list")
        check(sku0 in page.inner_text("#offline-list") and "Pending" in page.inner_text("#offline-list"), "pending list shows the sale")
        check("Offline" in page.inner_text("#offline-conn"), "connection status says Offline")
        page.screenshot(path=f"{OUT}/2_pending_list.png")

        # ---- back online: syncs exactly once ----
        ctx.set_offline(False)
        page.wait_for_function("!document.querySelector('#offline-chip')", timeout=15000)
        time.sleep(3)  # a double send would show up here
        check(len(api("GET", "/api/sales", 3)) == sales_before + 1, "after reconnect the sale reached the server exactly once")
        check(page.locator("#offline-list").count() == 0, "pending list is empty after sync")
        page.screenshot(path=f"{OUT}/3_synced.png")

        # ---- conflict: item deactivated while offline -> failed with the server's reason ----
        ctx.set_offline(True)
        page.goto(BASE + "/#/sales"); page.wait_for_selector("input[data-sku]")
        q2 = page.locator(f"input[data-sku='{sku0}']"); q2.fill("1"); q2.dispatch_event("input")
        page.click("button[data-act=sale]"); page.wait_for_selector("#offline-chip")
        api("PATCH", f"/api/items/{sku0}", 1, {"active": False})  # owner changes the catalogue meanwhile
        n_mid = len(api("GET", "/api/sales", 3))
        ctx.set_offline(False)
        page.wait_for_selector("#offline-chip-failed", timeout=15000)
        check(len(api("GET", "/api/sales", 3)) == n_mid, "rejected sale was not posted")
        page.goto(BASE + "/#/offline"); page.wait_for_selector("#offline-list .note.bad")
        reason = page.inner_text("#offline-list .note.bad")
        check("Server reason" in reason and len(reason) > 20, "failed item shows the server's reason: " + reason.replace("\n", " ")[:90])
        check(page.locator("[data-act=offline-retry]").count() == 1 and page.locator("[data-act=offline-edit]").count() == 1 and page.locator("[data-act=offline-discard]").count() == 1, "retry, edit and discard are offered")
        page.screenshot(path=f"{OUT}/4_conflict.png")
        # edit: re-enable the item, retry
        api("PATCH", f"/api/items/{sku0}", 1, {"active": True})
        page.click("[data-act=offline-retry]")
        page.wait_for_function("!document.querySelector('#offline-list')", timeout=15000)
        check(len(api("GET", "/api/sales", 3)) == n_mid + 1, "after the cause is fixed, retry posts the sale once")
        # discard path
        ctx.set_offline(True)
        page.goto(BASE + "/#/sales"); page.wait_for_selector("input[data-sku]")
        q3 = page.locator(f"input[data-sku='{sku0}']"); q3.fill("1"); q3.dispatch_event("input")
        page.click("button[data-act=sale]"); page.wait_for_selector("#offline-chip")
        page.goto(BASE + "/#/offline"); page.wait_for_selector("#offline-list")
        page.click("[data-act=offline-discard]"); page.click(".dialog-actions button.danger, .dialog-actions button.primary")
        page.wait_for_function("!document.querySelector('#offline-list')", timeout=5000)
        ctx.set_offline(False); time.sleep(2)
        check(len(api("GET", "/api/sales", 3)) == n_mid + 1, "discarded change never reaches the server")

        # ---- Arabic / RTL renders the page ----
        page.click("#lang"); page.goto(BASE + "/#/offline"); page.wait_for_selector("#offline-card")
        check(page.evaluate("document.documentElement.dir") == "rtl" and "العمل دون اتصال" in page.inner_text("#offline-card"), "Arabic RTL offline page")
        page.screenshot(path=f"{OUT}/5_arabic.png")
        check(not errors, "no page errors: " + "; ".join(errors)[:200])
        b.close()
finally:
    server.terminate()
print("\nOFFLINE CHECKS PASSED" if not problems else "\nFAILED: " + "; ".join(problems))
sys.exit(1 if problems else 0)
