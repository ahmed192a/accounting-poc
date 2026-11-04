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
        # the 400 below is the deliberate no-reason reversal being refused
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "400" not in m.text else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"http://127.0.0.1:{PORT}/")
        page.wait_for_selector(".role-line")

        # clerk (default): sees sales tools, never sees cash or reports
        txt = page.inner_text("main").lower()
        check("clerk" in txt and "quick sale" in txt, "clerk sees quick sale")
        check("cash" not in txt and "audit log" not in txt and "users and roles" not in txt and "ledger" not in txt, "clerk does not see cash, ledger, audit log or admin")
        page.screenshot(path=f"{OUT}/1_clerk.png")

        # manager takes the ETA connection offline
        page.select_option("#user", "2"); page.wait_for_selector("text=Simulate offline")
        page.click("text=Simulate offline"); page.wait_for_selector("text=ETA offline")
        check(page.inner_text("#etaPill") == "ETA offline", "header shows ETA offline")

        # clerk sells while offline
        page.select_option("#user", "3"); page.wait_for_selector("text=Complete sale")
        page.fill("input[data-sku=TEA-250]", "2"); page.fill("input[data-sku=SPICE-LOOSE]", "0")
        total = page.inner_text("#saleTotal")
        check("102.60" in total, f"live total includes 14% VAT (got {total})")
        page.click("text=Complete sale"); page.wait_for_selector(".note.warn")
        check("Queued" in page.inner_text(".note"), "offline sale completes with receipt queued")
        page.screenshot(path=f"{OUT}/2_offline_sale.png")

        # time passes: 5 x 6h = 30h, deadline missed
        for _ in range(5):
            page.click("text=Advance clock"); page.wait_for_timeout(150)
        page.wait_for_selector(".chip.bad:has-text('Overdue')")
        check("Overdue" in page.inner_text("main"), "queued receipt flagged overdue after the 24h window")
        page.screenshot(path=f"{OUT}/3_overdue.png")

        # connection returns, clerk syncs
        page.select_option("#user", "2"); page.wait_for_selector("text=Go online"); page.click("text=Go online")
        page.select_option("#user", "3"); page.wait_for_selector("text=Sync queue now"); page.click("text=Sync queue now")
        page.wait_for_selector(".chip.good:has-text('Submitted')")
        check(True, "sync submits the queued receipt")

        # owner: everything
        page.select_option("#user", "1"); page.wait_for_selector("text=Ledger")
        txt = page.inner_text("main").lower()
        check(all(k in txt for k in ["cash", "receivables", "ledger", "audit log", "approval queue"]), "owner sees finance, ledger, audit, approvals")
        page.screenshot(path=f"{OUT}/4_owner.png", full_page=True)

        # reverse a ledger entry from the UI (needs a reason)
        page.select_option("#user", "4"); page.wait_for_selector("#rev-reason")
        page.click("button[data-act=reverse] >> nth=0"); page.wait_for_selector("#toast.err")
        check("reason" in page.inner_text("#toast").lower(), "reversal without a reason is refused in the UI")
        page.fill("#rev-reason", "Customer returned goods")
        page.click("button[data-act=reverse] >> nth=0"); page.wait_for_selector("text=reversed")
        check("balanced" in page.inner_text("main").lower() and "NOT" not in page.inner_text("main"), "trial balance still balanced after reversal")

        # auditor read-only, admin sees no money
        page.select_option("#user", "5"); page.wait_for_selector("text=Audit log")
        txt = page.inner_text("main").lower()
        check(page.locator("button.primary, [data-act=reverse], [data-act=sale], [data-act=lock], [data-act=approve]").count() == 0 and "quick sale" not in " ".join(page.locator("h2").all_inner_texts()).lower(), "auditor has no write controls")
        check("ledger" in txt and "audit log" in txt and "receivables" in txt, "auditor can read ledger, audit log and reports")
        page.select_option("#user", "6"); page.wait_for_selector("text=Users and roles")
        txt = page.inner_text("main").lower()
        heads = " | ".join(page.locator("h2").all_inner_texts()).lower()
        print("  admin cards:", heads)
        check(not any(k in heads for k in ["cash", "receivables", "payables", "ledger", "sales today", "audit"]), "admin/developer sees no financial cards")
        check("create and approve the same bill" in txt, "SoD warning shown for the owner role")
        page.screenshot(path=f"{OUT}/5_admin.png", full_page=True)

        # Arabic + RTL
        page.select_option("#user", "3"); page.wait_for_selector("text=Complete sale")
        page.click("#lang"); page.wait_for_selector("text=إتمام البيع")
        check(page.evaluate("document.documentElement.dir") == "rtl", "Arabic switches the page to RTL")
        page.screenshot(path=f"{OUT}/6_arabic.png")

        check(not errors, f"no browser console errors {errors}")
        b.close()
finally:
    server.terminate()

print("\nFAILED:" if problems else "\nALL UI CHECKS PASSED", problems or "")
sys.exit(1 if problems else 0)
