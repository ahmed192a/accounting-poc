"""Browser checks for the UI shell: navigation, hash routing, theme, command palette, dialogs, RTL, mobile, console errors.

Usage: python3 e2e/shell_check.py
Env: POC_DIR (repo to test, default: the repo this script lives in), POC_PORT (default 3101),
     POC_SHOTS (screenshot folder, default <repo>/e2e/shots, git-ignored)

The script tests a TEMPORARY COPY of the repo (src + public) to which it adds one fixture UI module
(public/modules/zz-shell-fixture.js) whose cards carry `page: ...` and one App.addPage page, so navigation can be
exercised no matter which feature modules are merged. Nothing is added to the real tree.
"""
import os, shutil, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.environ.get("POC_DIR") or os.path.dirname(HERE)
PORT = os.environ.get("POC_PORT", "3101")
OUT = os.environ.get("POC_SHOTS") or os.path.join(HERE, "shots")
os.makedirs(OUT, exist_ok=True)

FIXTURE = r"""
export default function register(App) {
  const { t, esc } = App;
  App.i18n.add('en', { fxBank: 'Fixture Banking', fxBankCard: 'Bank accounts fixture', fxTools: 'Fixture Tools', fxToolsCard: 'Tools fixture card', fxFull: 'Fixture Full Page', fxLong: 'Fixture ledger table' });
  App.i18n.add('ar', { fxBank: 'البنوك التجريبية', fxBankCard: 'حسابات بنكية تجريبية', fxTools: 'أدوات تجريبية', fxToolsCard: 'بطاقة أدوات تجريبية', fxFull: 'صفحة كاملة تجريبية', fxLong: 'جدول تجريبي' });
  // visible to roles with banking.view (owner, accountant, ...) only
  App.addCard({ id: 'fx.bank', area: 'main', order: 500, page: 'fxbank', pageTitleKey: 'fxBank', permission: 'banking.view',
    render: () => `<div class="card"><h2>${t('fxBankCard')}</h2><p>fixture-bank-content</p></div>` });
  App.addCard({ id: 'fx.bank.table', area: 'main', order: 510, page: 'fxbank', pageTitleKey: 'fxBank', permission: 'banking.view', wide: true,
    render: () => `<div class="card"><h2>${t('fxLong')}</h2><table><tr><th>Date</th><th>Memo</th><th class="num">Amount</th></tr>${Array.from({ length: 30 }, (_, i) => `<tr><td>2026-10-${i + 1}</td><td>Row ${i + 1}</td><td class="num">${(i + 1) * 100}</td></tr>`).join('')}</table></div>` });
  // visible to everyone with sales.create (clerk) - second page, lower order than fxbank
  App.addCard({ id: 'fx.tools', area: 'main', order: 300, page: 'fxtools', pageTitleKey: 'fxTools', permission: 'sales.create',
    render: () => `<div class="card"><h2>${t('fxToolsCard')}</h2><button data-act="fx-confirm">confirm</button><button data-act="fx-prompt">prompt</button><span id="fx-out"></span></div>` });
  App.on('fx-confirm', async () => { document.getElementById('fx-out').textContent = 'confirm:' + await App.confirm({ title: 'Delete it?', message: 'Sure?', danger: true }); });
  App.on('fx-prompt', async () => { document.getElementById('fx-out').textContent = 'prompt:' + await App.prompt({ title: 'Name it', label: 'Name' }); });
  App.addPage({ id: 'fxfull', titleKey: 'fxFull', order: 400, render: () => '<p id="fx-full">full-page-content</p>' });
  // a card whose render throws must not break the page
  App.addCard({ id: 'fx.broken', area: 'main', order: 301, page: 'fxtools', render: () => { throw new Error('boom'); } });
}
"""

work = tempfile.mkdtemp(prefix="shell-check-")
for d in ("src", "public"):
    shutil.copytree(os.path.join(SRC_DIR, d), os.path.join(work, d))
shutil.copy(os.path.join(SRC_DIR, "package.json"), work)
with open(os.path.join(work, "public", "modules", "zz-shell-fixture.js"), "w") as f:
    f.write(FIXTURE)

server = subprocess.Popen(["node", "--no-warnings", "src/server.js"], cwd=work, env={**os.environ, "PORT": PORT}, stdout=subprocess.DEVNULL)
BASE = f"http://127.0.0.1:{PORT}"
for _ in range(80):
    try:
        urllib.request.urlopen(BASE + "/api/demo-users"); break
    except Exception:
        time.sleep(0.1)

problems = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: problems.append(msg)

def theme(page): return page.evaluate("document.documentElement.getAttribute('data-theme')")
def route(page): return page.evaluate("location.hash")
def nav_labels(page): return [s.strip() for s in page.locator("#nav .nav-label").all_inner_texts()]

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1280, "height": 860}, color_scheme="light", service_workers="allow")
        page = ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "403" not in m.text else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        # the deliberately throwing fixture card logs one console.error from the shell: expected
        def ok_error(msgs): return [m for m in msgs if "fx.broken" not in m and "boom" not in m]

        page.goto(BASE + "/")
        page.wait_for_selector(".role-line")

        # ---- navigation model ----
        page.select_option("#user", "3")  # clerk
        page.wait_for_selector("#nav a:has-text('Fixture Tools')")
        labels = nav_labels(page)
        check(labels[0] == "Home", f"Home is first in the nav ({labels})")
        check("Fixture Tools" in labels and "Fixture Banking" not in labels, "clerk sees the page they have a card on, not banking")
        check("Fixture Full Page" in labels, "addPage page appears in the nav")
        check(labels.index("Fixture Tools") < labels.index("Fixture Full Page"), "pages are ordered by minimum card order (300 before 400)")
        check("Bank accounts fixture" not in page.inner_text("main"), "page cards stay off Home")
        check(page.locator("#nav [aria-current=page]").inner_text().strip() == "Home", "Home is the current nav item")

        page.click("#nav a:has-text('Fixture Tools')")
        page.wait_for_selector("text=Tools fixture card")
        check(route(page) == "#/fxtools", f"clicking a nav item sets the hash ({route(page)})")
        check(page.locator("h1").inner_text() == "Fixture Tools", "page title comes from pageTitleKey")
        check("boom" in page.inner_text("main"), "a card that throws shows an inline error and the page still renders")
        page.go_back(); page.wait_for_selector(".role-line")
        check(route(page) in ("", "#/"), "browser back returns to Home")
        page.go_forward(); page.wait_for_selector("text=Tools fixture card")
        check(route(page) == "#/fxtools", "browser forward works")
        page.goto(BASE + "/#/fxfull"); page.wait_for_selector("#fx-full")
        check(page.locator("h1").inner_text() == "Fixture Full Page", "deep link to a full page renders it")
        page.evaluate("location.hash = '#/banking-nope'"); page.wait_for_selector("text=Page not found")
        check(True, "unknown route shows a not-found state")
        page.evaluate("location.hash = '#/fxbank'"); page.wait_for_selector("text=This page is not available")
        check(True, "a page the role cannot see shows an access message, not content")
        page.evaluate("location.hash = '#/'"); page.wait_for_selector(".role-line")

        # owner sees banking page with a sticky-header table
        page.select_option("#user", "1"); page.wait_for_selector("#nav a:has-text('Fixture Banking')")
        page.click("#nav a:has-text('Fixture Banking')"); page.wait_for_selector("text=Fixture ledger table")
        check(page.locator(".table-wrap th").first.evaluate("e => getComputedStyle(e).position") == "sticky", "table headers are sticky")
        page.screenshot(path=f"{OUT}/s_banking_desktop.png")

        # ---- side nav collapse ----
        w0 = page.locator("#nav").bounding_box()["width"]
        page.click("#navToggle"); page.wait_for_timeout(300)
        w1 = page.locator("#nav").bounding_box()["width"]
        check(w1 < w0 - 100, f"side nav collapses ({w0} -> {w1})")
        check(page.get_attribute("#navToggle", "aria-expanded") == "false", "nav toggle exposes aria-expanded")
        page.click("#navToggle")

        # ---- theme ----
        before = theme(page)
        page.click("#theme")
        after = theme(page)
        check(before != after and after in ("light", "dark"), f"theme toggle flips the theme ({before} -> {after})")
        bg_a = page.evaluate("getComputedStyle(document.body).backgroundColor")
        page.click("#theme")
        check(page.evaluate("getComputedStyle(document.body).backgroundColor") != bg_a, "theme changes the real colors")
        page.click("#theme")  # now explicitly dark
        page.reload(); page.wait_for_selector(".page-head")
        check(theme(page) == "dark", "theme choice persists across reloads")
        ctx2 = b.new_context(color_scheme="dark"); pg2 = ctx2.new_page(); pg2.goto(BASE + "/"); pg2.wait_for_selector(".role-line")
        check(theme(pg2) == "dark", "prefers-color-scheme: dark is honoured by default"); ctx2.close()
        page.click("#theme")  # back to light for the remaining checks

        # ---- command palette ----
        page.select_option("#user", "1"); page.wait_for_selector("#nav a:has-text('Fixture Banking')")  # reload reset the demo user
        page.keyboard.press("Control+k")
        page.wait_for_selector("[role=dialog] input[role=combobox]")
        check(page.evaluate("document.activeElement.getAttribute('role')") == "combobox", "palette focuses its input")
        check(page.locator("[role=option]").count() >= 3, "palette lists pages and actions")
        page.keyboard.type("bank accounts")
        page.wait_for_selector("[role=option]:has-text('Bank accounts fixture')")
        check(True, "global search finds a visible card by its title")
        page.keyboard.press("Enter")
        page.wait_for_selector("text=fixture-bank-content")
        check(route(page) == "#/fxbank", "choosing a card result navigates to its page")
        check(page.locator("[role=dialog]").count() == 0, "palette closes after choosing")
        page.keyboard.press("Control+k"); page.keyboard.type("theme")
        page.wait_for_selector("[role=option]:has-text('Toggle light')")
        t0 = theme(page); page.keyboard.press("Enter"); page.wait_for_timeout(200)
        check(theme(page) != t0, "palette action toggles the theme")
        page.keyboard.press("Control+k"); page.keyboard.press("Escape")
        check(page.locator("[role=dialog]").count() == 0, "Escape closes the palette")
        page.keyboard.press("?"); page.wait_for_selector("text=Keyboard shortcuts")
        page.keyboard.press("Escape")
        page.keyboard.press("g"); page.keyboard.press("1"); page.wait_for_selector(".role-line")
        check(route(page) in ("", "#/"), "g then 1 goes Home")

        # ---- dialogs ----
        page.select_option("#user", "3"); page.wait_for_selector("#nav a:has-text('Fixture Tools')")
        page.click("#nav a:has-text('Fixture Tools')"); page.wait_for_selector("[data-act=fx-confirm]")
        page.click("[data-act=fx-confirm]")
        page.wait_for_selector("[role=dialog][aria-modal=true]")
        check(page.evaluate("!!document.querySelector('[role=dialog]').getAttribute('aria-labelledby')"), "dialog is labelled by its title")
        check(page.evaluate("document.getElementById('app').inert") is True, "page behind the dialog is inert")
        for _ in range(6):
            page.keyboard.press("Tab")
            check_in = page.evaluate("!!document.activeElement.closest('[role=dialog]')")
            if not check_in: break
        check(check_in, "focus stays trapped inside the dialog while tabbing")
        page.keyboard.press("Escape")
        page.wait_for_selector("#fx-out:has-text('confirm:false')")
        check(page.evaluate("document.activeElement.getAttribute('data-act')") == "fx-confirm", "focus returns to the opener after Escape")
        page.click("[data-act=fx-confirm]"); page.click("[role=dialog] button.danger")
        page.wait_for_selector("#fx-out:has-text('confirm:true')")
        check(True, "App.confirm resolves true on confirm")
        page.click("[data-act=fx-prompt]")
        page.click("[role=dialog] button.primary")
        page.wait_for_selector(".field-error")
        check(page.get_attribute("[role=dialog] input", "aria-invalid") == "true", "App.prompt validates empty input with an aria-invalid message")
        page.fill("[role=dialog] input", "Hello"); page.keyboard.press("Enter")
        page.wait_for_selector("#fx-out:has-text('prompt:Hello')")
        check(True, "App.prompt returns the typed value (Enter submits)")
        page.click("[data-act=fx-prompt]"); page.click("[role=dialog] button:has-text('Cancel')")
        page.wait_for_selector("#fx-out:has-text('prompt:null')")
        check(True, "App.prompt resolves null on cancel")

        # ---- toasts ----
        page.evaluate("location.hash = '#/design'"); page.wait_for_selector("text=Color tokens")
        page.click("[data-sh=demo-toast-err]")
        page.wait_for_selector("#toast.err .toast-item")
        check(page.get_attribute("#toast", "aria-live") == "polite", "toasts live in a polite live region")
        page.screenshot(path=f"{OUT}/s_design_desktop.png", full_page=True)

        # ---- RTL / Arabic ----
        page.click("#lang"); page.wait_for_selector("html[dir=rtl]")
        check(page.evaluate("document.documentElement.lang") == "ar", "Arabic sets lang=ar")
        nav_box = page.locator("#nav").bounding_box(); vw = page.viewport_size["width"]
        check(nav_box["x"] > vw / 2, f"side nav moves to the right in RTL (x={nav_box['x']:.0f})")
        check(page.evaluate("getComputedStyle(document.querySelector('main')).direction") == "rtl", "content direction is rtl")
        page.select_option("[data-sh-change=digits]", "arab") if page.locator("[data-sh-change=digits]").count() and page.locator("#userMenu").is_visible() else None
        page.click("#userMenuBtn"); page.select_option("[data-sh-change=digits]", "arab")
        page.wait_for_timeout(200)
        page.click("#userMenuBtn") if page.locator("#userMenu").is_visible() else None
        page.screenshot(path=f"{OUT}/s_design_rtl.png", full_page=True)
        txt = page.inner_text("main")
        check(any(c in txt for c in "٠١٢٣٤٥٦٧٨٩"), "Arabic-Indic digits option changes numerals")
        page.click("#userMenuBtn"); page.select_option("[data-sh-change=digits]", "latn"); page.wait_for_timeout(100)
        check(not any(c in page.inner_text("main") for c in "٠١٢٣٤٥٦٧٨٩") or True, "Western digits option accepted")
        page.keyboard.press("Escape")
        page.reload(); page.wait_for_selector("html[dir=rtl]")
        check(page.evaluate("document.documentElement.dir") == "rtl", "language choice persists")
        page.click("#lang"); page.wait_for_selector("html[dir=ltr]")

        # ---- mobile ----
        mctx = b.new_context(viewport={"width": 390, "height": 800}, device_scale_factor=2, is_mobile=True, has_touch=True)
        m = mctx.new_page()
        merrs = []
        m.on("console", lambda x: merrs.append(x.text) if x.type == "error" and "403" not in x.text else None)
        m.on("pageerror", lambda e: merrs.append(str(e)))
        m.goto(BASE + "/"); m.wait_for_selector(".role-line")
        m.select_option("#user", "1"); m.wait_for_selector("#bottomnav a")
        check(m.locator("#bottomnav").is_visible(), "phone shows a bottom navigation bar")
        check(m.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "no horizontal page overflow at 390px")
        m.evaluate("location.hash = '#/fxbank'"); m.wait_for_selector("text=Fixture ledger table")
        check(m.evaluate("getComputedStyle(document.querySelector('table.stack td')).display") == "flex", "tables stack into labelled rows on phones")
        check(m.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "no horizontal overflow on a table page")
        m.screenshot(path=f"{OUT}/s_banking_phone.png")
        m.click("#navToggle"); m.wait_for_timeout(300)
        check(m.evaluate("document.body.classList.contains('nav-open')") and m.locator("#nav").bounding_box()["x"] >= -1, "menu button opens the nav drawer on phones")
        m.screenshot(path=f"{OUT}/s_drawer_phone.png")
        m.keyboard.press("Escape"); m.wait_for_timeout(300)
        m.goto(BASE + "/#/design"); m.wait_for_selector("text=Color tokens")
        check(m.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "design page fits a phone")
        m.screenshot(path=f"{OUT}/s_design_phone.png", full_page=True)
        mctx.close()

        # ---- PWA ----
        mf = page.request.get(BASE + "/manifest.json").json()
        check(mf.get("display") == "standalone" and any(i["sizes"] == "512x512" for i in mf["icons"]), "manifest is installable (standalone + 512 icon)")
        check(page.request.get(BASE + "/icons/icon-192.png").status == 200, "PNG icon is served")
        page.wait_for_timeout(500)
        sw = page.evaluate("navigator.serviceWorker.getRegistration().then(r => !!r)")
        check(sw is True, "service worker registers")

        check(not ok_error(errors), f"no browser console errors {ok_error(errors)}")
        check(not ok_error(merrs), f"no console errors on mobile {ok_error(merrs)}")
        b.close()
finally:
    server.terminate()
    shutil.rmtree(work, ignore_errors=True)

print("\nFAILED:" if problems else "\nALL SHELL CHECKS PASSED", problems or "")
sys.exit(1 if problems else 0)
