import subprocess, time, sys, os, urllib.request
from playwright.sync_api import sync_playwright

# Usage: python3 e2e/ui_check.py
# Env: POC_DIR (repo to test, default: the repo this script lives in), POC_PORT (default 3100),
#      POC_SHOTS (screenshot folder, default <repo>/e2e/shots, git-ignored)
HERE = os.path.dirname(os.path.abspath(__file__))
POC_DIR = os.environ.get("POC_DIR") or os.path.dirname(HERE)
PORT = os.environ.get("POC_PORT", "3100")
OUT = os.environ.get("POC_SHOTS") or os.path.join(HERE, "shots")
os.makedirs(OUT, exist_ok=True)
server = subprocess.Popen(["node", "--no-warnings", "src/server.js"], cwd=POC_DIR, env={**os.environ, "PORT": PORT})
for _ in range(50):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/demo-users"); break
    except Exception:
        time.sleep(0.1)

problems = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: problems.append(msg)

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
        errors = []

        def sw(uid):
            """Switch demo user and let the UI settle (data reload is asynchronous)."""
            page.select_option("#user", uid)
            page.wait_for_timeout(300)
            try: page.wait_for_load_state("networkidle", timeout=5000)
            except Exception: pass
            page.wait_for_timeout(500)

        def nav_hrefs():
            hs = page.eval_on_selector_all("nav a", "els => els.map(e => e.getAttribute('href'))")
            return list(dict.fromkeys(h for h in hs if h))

        def ws(sel, timeout=8000):
            """Wait for a selector, looking through every nav page (the shell moves cards onto pages)."""
            end = time.time() + timeout / 1000
            while time.time() < end:
                if page.locator(sel).first.is_visible():
                    return
                hrefs = nav_hrefs()
                for h in hrefs:
                    page.evaluate("h => { location.hash = h }", h); page.wait_for_timeout(250)
                    if page.locator(sel).first.is_visible():
                        return
                page.wait_for_timeout(200)
            page.wait_for_selector(sel, timeout=2000)



        def alltext():
            """Text of every nav page for the current user (cards live on separate pages in the shell)."""
            hrefs = nav_hrefs()
            out = []
            for h in hrefs:
                page.evaluate("h => { location.hash = h }", h); page.wait_for_timeout(350)
                out.append(page.inner_text("main"))
            return "\n".join(out)

        # the 400 below is the deliberate no-reason reversal being refused
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "400" not in m.text and "403" not in m.text else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"http://127.0.0.1:{PORT}/")
        page.wait_for_selector(".role-line")

        # clerk (default): sees sales tools, never sees cash or reports
        txt = alltext().lower()
        check("clerk" in txt and "quick sale" in txt, "clerk sees quick sale")
        check("cash" not in txt and "audit log" not in txt and "users and roles" not in txt and "ledger" not in txt, "clerk does not see cash, ledger, audit log or admin")
        page.screenshot(path=f"{OUT}/1_clerk.png")

        # manager takes the ETA connection offline
        sw("2"); ws("text=Simulate offline")
        page.click("text=Simulate offline"); ws("text=ETA offline")
        check(page.inner_text("#etaPill") == "ETA offline", "header shows ETA offline")

        # clerk sells while offline
        sw("3"); ws("text=Complete sale")
        page.fill("input[data-sku=TEA-250]", "2"); page.fill("input[data-sku=SPICE-LOOSE]", "0")
        page.wait_for_timeout(400); total = page.inner_text("#saleTotal")
        check("102.60" in total, f"live total includes 14% VAT (got {total})")
        page.click("text=Complete sale"); ws(".note.warn")
        check("Queued" in page.inner_text(".note"), "offline sale completes with receipt queued")
        page.screenshot(path=f"{OUT}/2_offline_sale.png")

        # time passes: 5 x 6h = 30h, deadline missed
        for _ in range(5):
            page.click("text=Advance clock"); page.wait_for_timeout(150)
        ws(".chip.bad:has-text('Overdue')")
        check("Overdue" in alltext(), "queued receipt flagged overdue after the 24h window")
        page.screenshot(path=f"{OUT}/3_overdue.png")

        # connection returns, clerk syncs
        sw("2"); ws("text=Go online"); page.click("text=Go online")
        sw("3"); ws("text=Sync queue now"); page.click("text=Sync queue now")
        ws(".chip.good:has-text('Submitted')")
        check(True, "sync submits the queued receipt")

        # owner: everything
        sw("1"); ws("text=Ledger")
        txt = alltext().lower()
        check(all(k in txt for k in ["cash", "receivables", "ledger", "audit log", "approval queue"]), "owner sees finance, ledger, audit, approvals")
        page.screenshot(path=f"{OUT}/4_owner.png", full_page=True)

        # reverse a ledger entry from the UI (needs a reason)
        sw("4"); ws("#rev-reason")
        page.click("button[data-act=reverse] >> nth=0"); page.wait_for_selector("#toast.err")
        check("reason" in page.inner_text("#toast").lower(), "reversal without a reason is refused in the UI")
        page.fill("#rev-reason", "Customer returned goods")
        page.click("button[data-act=reverse] >> nth=0"); ws("text=reversed")
        check("balanced" in alltext().lower() and "NOT" not in alltext(), "trial balance still balanced after reversal")

        # auditor read-only, admin sees no money
        sw("5"); ws("text=Audit log")
        txt = alltext().lower()
        check(page.locator("button.primary, [data-act=reverse], [data-act=sale], [data-act=lock], [data-act=approve]").count() == 0 and "quick sale" not in " ".join(page.locator("h2").all_inner_texts()).lower(), "auditor has no write controls")
        check("ledger" in txt and "audit log" in txt and "receivables" in txt, "auditor can read ledger, audit log and reports")
        sw("6"); ws("text=Users and roles")
        txt = alltext().lower()
        heads = " | ".join(page.locator("h2").all_inner_texts()).lower()
        print("  admin cards:", heads)
        check(not any(k in heads for k in ["cash", "receivables", "payables", "ledger", "sales today", "audit"]), "admin/developer sees no financial cards")
        check("create and approve the same bill" in txt, "SoD warning shown for the owner role")
        page.screenshot(path=f"{OUT}/5_admin.png", full_page=True)

        # Arabic + RTL
        sw("3"); ws("text=Complete sale")
        page.click("#lang"); ws("text=إتمام البيع")
        check(page.evaluate("document.documentElement.dir") == "rtl", "Arabic switches the page to RTL")
        page.screenshot(path=f"{OUT}/6_arabic.png")

        check(not errors, f"no browser console errors {errors}")
        b.close()
finally:
    server.terminate()

print("\nFAILED:" if problems else "\nALL UI CHECKS PASSED", problems or "")
sys.exit(1 if problems else 0)
