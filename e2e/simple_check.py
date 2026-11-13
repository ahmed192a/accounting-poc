"""Browser journeys for simple mode (public/simple/): cash sale, credit sale, wallet sale, partial payment, reminder, share/print,
camera barcode (stubbed BarcodeDetector + fake camera) and typed fallback, offline cash sale, Arabic RTL glossary, mode hook.

Usage: python3 e2e/simple_check.py
Env: POC_DIR (repo to test, default: the repo this script lives in), POC_PORT (default 3102), POC_SHOTS (screenshot folder)

Each journey ends by checking full mode's numbers (ledger balanced, receivables) through the API, so "appears correctly in full-mode
reports" is tested, not assumed. The camera is a Chromium fake device; BarcodeDetector is stubbed because headless Chromium has no decoder.
"""
import json, os, re, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
POC_DIR = os.environ.get("POC_DIR") or os.path.dirname(HERE)
PORT = os.environ.get("POC_PORT", "3102")
OUT = os.environ.get("POC_SHOTS") or os.path.join(HERE, "shots")
os.makedirs(OUT, exist_ok=True)
BASE = f"http://127.0.0.1:{PORT}"
server = subprocess.Popen(["node", "--no-warnings", "src/server.js"], cwd=POC_DIR, env={**os.environ, "PORT": PORT}, stdout=subprocess.DEVNULL)
for _ in range(80):
    try: urllib.request.urlopen(BASE + "/api/demo-users"); break
    except Exception: time.sleep(0.1)

problems = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: problems.append(msg)

def api(path, method="GET", body=None, user=1):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"x-user-id": str(user), "content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read() or b"{}")

def piastres(text):  # "EGP 1,234.50" or "1,234.50 EGP" -> 123450
    m = re.search(r"[\d,]+\.\d\d", text)
    return round(float(m.group(0).replace(",", "")) * 100)

def full_mode_ok():
    home = api("/api/home")
    return home["widgets"]["ledger"]["balanced"], home["widgets"]["receivables"]["total"]

INIT = """
window.__shared = []; window.__printed = 0;
navigator.share = (d) => { window.__shared.push(d); return Promise.resolve(); };
window.print = () => { window.__printed++; };
window.__code = null;
window.BarcodeDetector = class { static async getSupportedFormats() { return ['ean_13']; } async detect() { return window.__code ? [{ rawValue: window.__code }] : []; } };
"""

try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
        ctx = b.new_context(viewport={"width": 390, "height": 800}, permissions=["camera"], service_workers="allow")
        ctx.add_init_script(INIT)
        page = ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        def open_simple(route="today"):
            page.goto(f"{BASE}/simple/#/{route}")
            page.wait_for_selector("body[data-ready='1']")

        def close_sheet():
            page.click("[data-act=closesheet]"); page.wait_for_selector("#sheet:not([open])", state="attached")

        # ---- Today screen on a fresh book ----
        open_simple()
        check(page.title() == "Daily book", "simple shell loads at /simple/")
        check(page.locator("[data-testid=sold-total]").count() == 1 and page.locator("[data-testid=drawer]").count() == 1, "today shows sold total and drawer for the owner")
        check("Not connected" in page.locator("[data-testid=compliance]").inner_text(), "compliance light is a labelled placeholder")
        check(page.locator("#user option").count() >= 3, "demo user switcher is present (owner selected by default)")
        sold0 = piastres(page.locator("[data-testid=sold-total]").inner_text())
        drawer0 = piastres(page.locator("[data-testid=drawer]").inner_text())
        page.screenshot(path=os.path.join(OUT, "simple-today.png"))

        # ---- Journey 1: cash sale, then share / WhatsApp / print ----
        page.click("a[data-tab=sell]")
        page.wait_for_selector("#grid .tile")
        page.fill("#q", "tea")
        check(page.locator("#grid .tile").count() == 1, "item search filters the grid")
        page.click("#grid .tile")
        page.click("[data-act=inc]")
        check(page.locator("[data-testid=qty-TEA-250]").inner_text() == "2", "quantity stepper goes to 2")
        page.click("[data-act=dec]"); page.click("[data-act=dec]")
        check(page.locator("[data-testid=empty-cart]").count() == 1 and page.locator("#confirm").is_disabled(), "stepper down to zero empties the basket and disables confirm")
        page.click("#grid .tile"); page.click("[data-act=inc]")   # 2 x 45.00
        check(piastres(page.locator("[data-testid=subtotal]").inner_text()) == 9000, "subtotal is 2 x 45.00 = 90.00")
        page.click("#confirm")
        page.wait_for_selector("[data-testid=receipt]")
        receipt = page.locator("[data-testid=receipt]").inner_text()
        check("Black tea 250g x2" in receipt and "Cash" in receipt, "cash sale receipt lists the item and the method")
        check(page.get_attribute("#wa", "href").startswith("https://wa.me/?text="), "WhatsApp link carries the receipt text")
        page.click("[data-act=share]")
        check(len(page.evaluate("window.__shared")) == 1 and "Black tea" in page.evaluate("window.__shared[0].text"), "share uses navigator.share with the receipt")
        page.click("[data-act=print]")
        check(page.evaluate("window.__printed") == 1 and "Black tea" in page.locator("#print-area").text_content(), "print fills the print area and calls print")
        check(page.evaluate("getComputedStyle(document.getElementById('print-area')).display") == "none", "print area is hidden on screen (shown by the print stylesheet)")
        close_sheet()
        page.click("a[data-tab=today]")
        sold1 = piastres(page.locator("[data-testid=sold-total]").inner_text())
        drawer1 = piastres(page.locator("[data-testid=drawer]").inner_text())
        check(sold1 - sold0 >= 9000 and sold1 - sold0 <= 9000 * 1.5, f"sold today rose by the sale (incl. tax): {sold0} -> {sold1}")
        check(drawer1 - drawer0 == sold1 - sold0, "drawer rose by the same amount (cash account)")
        bal, _ = full_mode_ok(); check(bal, "full mode: ledger still balanced after the cash sale")

        # ---- Journey 2: credit sale to a customer, shows under Owed ----
        page.click("a[data-tab=sell]"); page.wait_for_selector("#grid .tile")
        page.click("#grid .tile[data-sku=RICE-1K]")
        page.check("input[name=method][value=credit]", force=True)
        page.click("#confirm")
        check(page.locator("#toast").is_visible() and "customer" in page.locator("#toast").inner_text().lower(), "credit sale without a customer is refused with a hint")
        page.select_option("#cust", label="Cafe Nile")
        page.click("#confirm")
        page.wait_for_selector("[data-testid=receipt]")
        r2 = page.locator("[data-testid=receipt]").inner_text()
        check("On credit" in r2 and "Cafe Nile" in r2 and "Not paid yet" in r2, "credit receipt says on credit and names the customer")
        check("wa.me/201012345678" in page.get_attribute("#wa", "href"), "credit receipt WhatsApp link goes to the customer's number")
        close_sheet()
        page.click("a[data-tab=owed]")
        row = page.locator("[data-testid=owed-row][data-name='Cafe Nile']")
        row.wait_for(timeout=5000)
        check(row.count() == 1, "Cafe Nile is listed under Owed")
        ag = api("/api/customers/aging")
        nile = next(r for r in ag["rows"] if r["customer"] == "Cafe Nile")
        check(nile["total"] >= 3200, f"aging (full mode) agrees: Cafe Nile owes {nile['total']}")
        bal, rec = full_mode_ok(); check(bal and rec == nile["total"], "full mode: receivables equals the simple Owed total and ledger is balanced")

        # ---- Journey 3: partial payment ----
        page.click("[data-testid=owed-row][data-name='Cafe Nile'] [data-act=pay]")
        page.wait_for_selector("#pay-amt")
        page.fill("#pay-amt", str((nile["total"] + 100) / 100))
        check(page.locator("#paysave").is_disabled() and page.locator("#pay-err").inner_text() != "", "paying more than owed is blocked")
        page.fill("#pay-amt", "10.00")
        check("Still owed" in page.locator("[data-testid=pay-left]").inner_text(), "dialog shows what is still owed")
        page.click("#paysave")
        page.wait_for_selector("#sheet:not([open])", state="attached")
        nile2 = next(r for r in api("/api/customers/aging")["rows"] if r["customer"] == "Cafe Nile")
        check(nile2["total"] == nile["total"] - 1000, f"partial payment of 10.00 reduced the debt: {nile['total']} -> {nile2['total']}")
        check(api("/api/payments")[0]["method"] == "cash" and api("/api/payments")[0]["amount"] == 1000, "payment recorded as cash through the payments service")
        # pay the rest by wallet
        page.click("[data-testid=owed-row][data-name='Cafe Nile'] [data-act=pay]"); page.wait_for_selector("#pay-amt")
        page.check("input[name=paym][value=wallet]", force=True); page.click("#paysave")
        page.wait_for_selector("#sheet:not([open])", state="attached")
        page.wait_for_selector("[data-testid=owed-row][data-name='Cafe Nile']", state="detached", timeout=5000)
        check(page.locator("[data-testid=owed-row][data-name='Cafe Nile']").count() == 0, "full payment removes the customer from Owed")
        bal, rec = full_mode_ok(); check(bal and rec == 0, "full mode: receivables back to zero, ledger balanced")

        # ---- Wallet sale (invoice to Walk-in + wallet payment) ----
        page.click("a[data-tab=sell]"); page.wait_for_selector("#grid .tile")
        page.click("#grid .tile[data-sku=OIL-1L]")
        page.check("input[name=method][value=wallet]", force=True)
        page.click("#confirm")
        try: page.wait_for_selector("[data-testid=receipt]", timeout=5000)
        except Exception: print("TOAST:", page.locator("#toast").inner_text())
        check("Wallet" in page.locator("[data-testid=receipt]").inner_text(), "wallet sale receipt")
        close_sheet()
        bal, rec = full_mode_ok(); check(bal and rec == 0, "wallet sale leaves nothing owed and the ledger balanced")
        check(any(i["customer"] == "Walk-in" and i["status"] == "paid" for i in api("/api/invoices")), "wallet sale is a paid Walk-in invoice in full mode")

        # ---- Reminder + days late (advance the demo clock) ----
        page.click("a[data-tab=sell]"); page.wait_for_selector("#grid .tile")
        page.click("#grid .tile[data-sku=TEA-250]"); page.check("input[name=method][value=credit]", force=True)
        page.select_option("#cust", label="Delta Traders"); page.click("#confirm"); page.wait_for_selector("[data-testid=receipt]"); close_sheet()
        api("/api/dev/advance-clock", "POST", {"hours": 24 * 20})   # invoice is due after 14 days: 6 days late
        page.reload(); page.wait_for_selector("body[data-ready='1']"); page.click("a[data-tab=owed]")
        row = page.locator("[data-testid=owed-row][data-name='Delta Traders']")
        row.wait_for(timeout=5000)
        check("6 days late" in row.inner_text(), "Owed shows days late from the due date: " + row.inner_text().replace("\n", " | "))
        row.locator("[data-act=remind]").click(); page.wait_for_selector("[data-testid=reminder-text]")
        check("Delta Traders" in page.locator("[data-testid=reminder-text]").inner_text() and "wa.me/" in page.get_attribute("#wa-remind", "href"), "reminder shows the message and a WhatsApp link (nothing is sent)")
        close_sheet()
        page.click("a[data-tab=today]")
        check("Delta Traders" in page.locator("#h-owed").locator("xpath=..").inner_text(), "Today lists the longest-waiting name")

        # ---- Barcode: typed fallback, then camera path (stubbed detector) ----
        page.click("a[data-tab=sell]"); page.wait_for_selector("#grid .tile")
        page.click("#scanbtn"); page.wait_for_selector("#cam")
        page.evaluate("window.__code = 'RICE-1K'")
        page.wait_for_selector("[data-testid=qty-RICE-1K]", timeout=5000)
        check(True, "camera scan (stubbed detector, fake camera) adds the item")
        page.evaluate("window.__code = null")
        page.fill("#code", "oil-1l"); page.click("[data-act=findcode]")
        page.wait_for_selector("[data-testid=qty-OIL-1L]")
        check(True, "typed code adds the item")
        page.fill("#code", "NOPE-000"); page.click("[data-act=findcode]")
        page.locator("#toast", has_text="No item").wait_for(timeout=5000); check(True, "unknown code says so")
        page.click("[data-act=stopscan]")
        check(page.locator("#scanpanel").is_hidden(), "scanner stops and closes")

        # ---- Offline: cash sale is kept on the device, then sent ----
        ctx.set_offline(True)
        page.click("#confirm")
        page.locator("#toast", has_text="Saved on this device").wait_for(timeout=5000)
        check(True, "offline cash sale is saved on the device")
        sales_before = len(api("/api/sales"))
        ctx.set_offline(False)
        page.evaluate("window.dispatchEvent(new Event('online'))")
        page.locator("#toast", has_text="sent").wait_for(timeout=8000)
        check(len(api("/api/sales")) == sales_before + 1, "queued sale reached the server exactly once after reconnecting")
        check(api("/api/home")["widgets"]["ledger"]["balanced"], "ledger balanced after replay")

        # ---- Arabic, RTL, glossary ----
        page.click("a[data-tab=words]"); page.wait_for_selector("#wlist dl")
        n_all = page.locator("#wlist [data-term]").count()
        page.fill("#wq", "receivable"); check(0 < page.locator("#wlist [data-term]").count() < n_all, "glossary search filters terms by ledger word")
        page.click("#lang")
        check(page.evaluate("document.documentElement.dir") == "rtl" and page.evaluate("document.documentElement.lang") == "ar", "Arabic switches the page to RTL")
        page.fill("#wq", "ليّ")
        check(page.locator("[data-term=receivable]").count() == 1, "glossary finds the Arabic word for 'owed to me'")
        page.screenshot(path=os.path.join(OUT, "simple-words-ar.png"))
        page.click("a[data-tab=today]")
        check("ج.م" in page.locator("[data-testid=sold-total]").inner_text(), "money shows in Arabic form")
        page.screenshot(path=os.path.join(OUT, "simple-today-ar.png"))
        page.click("#lang")

        # ---- Mode hook with full mode (full mode starts as demo user 3, the clerk, so use that user in the simple shell too) ----
        open_simple("today"); page.select_option("#user", label="Sara (clerk)"); page.wait_for_selector("[data-testid=sold-total]")
        page.goto(BASE + "/"); page.wait_for_url("**/simple/", timeout=8000)
        check(True, "full mode redirects a user whose ui.mode is simple")
        page.wait_for_selector("body[data-ready='1']")
        check(page.locator("[data-testid=drawer]").count() == 0, "clerk does not see the drawer balance")
        page.screenshot(path=os.path.join(OUT, "simple-clerk.png"))
        page.click("#full"); page.wait_for_selector("#simple-link")
        check("full=1" in page.url and "/simple/" not in page.url, "Full mode link opens full mode")
        page.goto(BASE + "/"); page.wait_for_selector("#simple-link"); page.wait_for_timeout(500)
        check("/simple/" not in page.url, "mode is now full: no redirect")

        # ---- Phone budget (informational): sale confirm latency on localhost, unthrottled ----
        open_simple("sell"); page.select_option("#user", label="Mona (owner)"); page.wait_for_selector("#grid .tile")
        page.wait_for_selector("[data-testid=empty-cart]")
        page.click("#grid .tile[data-sku=RICE-1K]")
        t0 = time.time(); page.click("#confirm"); page.wait_for_selector("[data-testid=receipt]"); ms = (time.time() - t0) * 1000
        print(f"INFO sale submit to receipt: {ms:.0f} ms (unthrottled, localhost; the 300 ms CI budget on a throttled profile is NOT measured here)")

        bad = [e for e in errors if "Failed to load resource" not in e]
        check(not bad, "no console errors" + (": " + "; ".join(bad[:3]) if bad else ""))
        b.close()
finally:
    server.terminate()

print("\nFAILED: " + "; ".join(problems) if problems else "\nall simple-mode checks passed")
sys.exit(1 if problems else 0)
