import subprocess, time, sys, os, shutil, tempfile, urllib.request
from playwright.sync_api import sync_playwright

# Usage: python3 e2e/tenancy_check.py
# Starts its own server (AUTH_REQUIRED=1, TENANTS_DIR in a temp folder) and checks multi-tenancy through the real UI and API:
# the operator creates a company in the Companies page, the new owner signs in, and the two companies share no data.
# Env: POC_DIR (repo to test), POC_PORT (default 3203), POC_SHOTS (screenshots, default /tmp/tenancy-shots)
HERE = os.path.dirname(os.path.abspath(__file__))
POC_DIR = os.environ.get("POC_DIR") or os.path.dirname(HERE)
PORT = os.environ.get("POC_PORT", "3203")
OUT = os.environ.get("POC_SHOTS") or "/tmp/tenancy-shots"
os.makedirs(OUT, exist_ok=True)
BASE = f"http://127.0.0.1:{PORT}"
OP_EMAIL, OP_PW = "platform-op@example.test", "Operator-Horse-Battery-9"            # secret-scan:ignore test fixture
BOSS_EMAIL, BOSS_PW = "boss@acme.test", "Acme-Strong-Pass-2026-x"                    # secret-scan:ignore test fixture
tdir = tempfile.mkdtemp(prefix="poc-e2e-tenants-")
env = {**os.environ, "PORT": PORT, "AUTH_REQUIRED": "1", "INITIAL_OWNER_EMAIL": OP_EMAIL, "INITIAL_OWNER_PASSWORD": OP_PW,
       "TENANTS_DIR": tdir, "REQUEST_LOG": "0"}
server = subprocess.Popen(["node", "--no-warnings", "src/server.js"], cwd=POC_DIR, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(80):
    try:
        urllib.request.urlopen(f"{BASE}/healthz"); break
    except Exception:
        time.sleep(0.1)

problems = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: problems.append(msg)

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        def login(email, pw):
            page.goto(BASE + "/")
            page.wait_for_selector("#auth-email", timeout=8000)
            page.fill("#auth-email", email); page.fill("#auth-pw", pw)
            page.click("[data-act=auth-login]")
            page.wait_for_selector("#auth-email", state="detached", timeout=8000)
            page.wait_for_selector("nav a", timeout=10000); page.wait_for_timeout(800)

        def api_session(email, pw):
            """Independent API client with its own cookies, as a second browser would be."""
            ctx = p.request.new_context(base_url=BASE)
            r = ctx.post("/api/auth/login", data={"email": email, "password": pw})
            return ctx, r.json().get("csrfToken"), r.status

        # 1. the operator signs in through the UI and creates a company on the Companies page
        login(OP_EMAIL, OP_PW)
        page.evaluate("location.hash = '#/tenants'"); page.wait_for_selector("#tenants-slug", timeout=8000)
        check(page.locator("text=Companies on this server").first.is_visible(), "operator sees the Companies page")
        page.screenshot(path=f"{OUT}/1-companies-before.png")
        page.fill("#tenants-slug", "acme"); page.fill("#tenants-name", "Acme Trading")
        page.fill("#tenants-email", BOSS_EMAIL); page.fill("#tenants-pw", BOSS_PW)
        page.click("[data-act=tenants-create]")
        page.wait_for_selector("text=Acme Trading", timeout=8000)
        check(page.locator("text=Company created").first.is_visible(), "company created from the UI")
        check(page.locator("text=Default company").first.is_visible(), "default company is listed beside the new one")
        page.screenshot(path=f"{OUT}/2-companies-after.png")

        # 2. the new owner signs in (no company name needed: the e-mail is unique) and sees their own company
        page.click("[data-act=auth-logout]"); page.wait_for_selector("#auth-email", timeout=8000)
        login(BOSS_EMAIL, BOSS_PW)
        page.evaluate("location.hash = '#/tenants'"); page.wait_for_selector("text=Only the operator company can manage tenants", timeout=8000)
        check(page.locator("text=Acme Trading").first.is_visible(), "new owner sees the name of their own company")
        check(page.locator("#tenants-slug").count() == 0, "a company owner gets no create-company form")
        page.screenshot(path=f"{OUT}/3-owner-of-acme.png")

        # 3. isolation through the API: a customer made in acme is invisible to the operator and vice versa
        boss, bcsrf, st = api_session(BOSS_EMAIL, BOSS_PW)
        check(st == 200, "acme owner API login")
        op, ocsrf, st = api_session(OP_EMAIL, OP_PW)
        check(st == 200, "operator API login")
        c1 = boss.post("/api/customers", data={"name": "Acme-only Customer"}, headers={"x-csrf-token": bcsrf})
        c2 = op.post("/api/customers", data={"name": "Default-only Customer"}, headers={"x-csrf-token": ocsrf})
        check(c1.status == 201 and c2.status == 201, "both companies create a customer (same id in each database)")
        check(c1.json()["id"] == c2.json()["id"], "the two customers share an id: separate databases")
        lb, lo = boss.get("/api/customers").text(), op.get("/api/customers").text()
        check("Acme-only" in lb and "Default-only" not in lb, "acme sees only its own customers")
        check("Default-only" in lo and "Acme-only" not in lo, "operator company sees only its own customers")
        check(boss.get("/api/tenants").status == 403, "acme owner cannot list tenants through the API")
        wrong = p.request.new_context(base_url=BASE).post("/api/auth/login", data={"email": OP_EMAIL, "password": OP_PW, "tenant": "acme"})
        check(wrong.status == 401, "operator credentials do not work against acme")

        # 4. suspend from the UI blocks the company
        page.click("[data-act=auth-logout]"); page.wait_for_selector("#auth-email", timeout=8000)
        login(OP_EMAIL, OP_PW)
        page.evaluate("location.hash = '#/tenants'"); page.wait_for_selector("[data-act=tenants-toggle]", timeout=8000)
        page.click("[data-act=tenants-toggle][data-slug=acme]"); page.wait_for_selector("text=Suspended", timeout=8000)
        check(boss.get("/api/home").status == 403, "suspended company is refused")
        page.screenshot(path=f"{OUT}/4-suspended.png")
        page.click("[data-act=tenants-toggle][data-slug=acme]"); page.wait_for_selector("[data-act=tenants-toggle][data-status=active]", timeout=8000)
        check(boss.get("/api/home").status == 200, "resumed company works again")

        # 5. export and backup (needs tenants.export, which the owner holds)
        bk = op.post("/api/tenants/acme/backup", headers={"x-csrf-token": ocsrf})
        check(bk.status == 200 and os.path.exists(bk.json()["file"]), "backup file written")
        ex = op.get("/api/tenants/acme/export")
        check(ex.status == 200 and "Acme-only" in ex.text() and "Default-only" not in ex.text(), "export holds acme data only")
        check(not errors, "no JavaScript errors: " + "; ".join(errors[:3]))
        b.close()
finally:
    server.terminate()
    try: server.wait(5)
    except Exception: server.kill()
    shutil.rmtree(tdir, ignore_errors=True)

print("\nALL TENANCY CHECKS PASSED" if not problems else f"\n{len(problems)} CHECK(S) FAILED")
sys.exit(1 if problems else 0)
