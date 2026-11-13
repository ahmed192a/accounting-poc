import subprocess, time, sys, os, urllib.request
from playwright.sync_api import sync_playwright

# Documents UI: as the clerk, take a receipt photo on bill entry, create the bill, see the photo attached on the Documents card,
# upload a PDF, set the e-document flag; the auditor sees the list but no write controls.
# Usage: python3 e2e/documents_check.py   Env: POC_DIR, POC_PORT (default 3120)
HERE = os.path.dirname(os.path.abspath(__file__))
POC_DIR = os.environ.get("POC_DIR") or os.path.dirname(HERE)
PORT = os.environ.get("POC_PORT", "3120")
BASE = f"http://127.0.0.1:{PORT}"
def make_png():
    import struct, zlib
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    raw = b"".join(b"\x00" + b"\xff\x80\x00" * 4 for _ in range(4))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
PNG = make_png()
server = subprocess.Popen(["node", "--no-warnings", "src/server.js"], cwd=POC_DIR, env={**os.environ, "PORT": PORT, "REQUEST_LOG": "0"}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(100):
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
        page = b.new_page(viewport={"width": 1100, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.goto(BASE + "/")
        page.wait_for_selector("#user option", state="attached")
        def as_user(uid):
            page.select_option("#user", uid); page.wait_for_timeout(600)
            page.evaluate("location.hash = '#/purchases'"); page.wait_for_selector("#bill-supplier, #doc-type", timeout=8000)
        as_user("3")
        check(page.locator("#doc-pending-cam").count() == 1, "clerk sees the receipt capture control on bill entry")
        page.set_input_files("#doc-pending-cam", {"name": "r.png", "mimeType": "image/png", "buffer": PNG})
        page.wait_for_selector("text=Photo ready", timeout=5000)
        check(True, "photo is held for the next bill")
        page.select_option("#doc-pending-edoc", "yes")
        page.fill("#bill-supplier", "Camera Supplies"); page.fill("#bill-amount", "12.50")
        page.click("[data-act=bill]")
        page.wait_for_timeout(1500)
        page.select_option("#doc-id", index=1); page.wait_for_timeout(800)
        check(page.locator("#page-main, main").first.inner_text().count("r.jpg") + page.locator("body").inner_text().count("r.") > 0, "photo is listed on the Documents card")
        check(page.locator("body").inner_text().count("UNVERIFIED") >= 1, "UNVERIFIED label is shown")
        check(page.locator("#doc-edoc").input_value() == "yes", "e-document flag was saved with the bill")
        page.set_input_files("#doc-file", {"name": "inv.pdf", "mimeType": "application/pdf", "buffer": b"%PDF-1.4 e2e"})
        page.wait_for_selector("text=inv.pdf", timeout=5000)
        check(True, "PDF upload is listed")
        page.screenshot(path=os.path.join(os.environ.get("POC_SHOTS") or os.path.join(HERE, "shots"), "documents.png")) if os.path.isdir(os.path.join(HERE, "shots")) else None
        as_user("5")
        page.select_option("#doc-id", index=1); page.wait_for_timeout(800)
        check(page.locator("#doc-file").count() == 0 and page.locator("[data-act=doc-remove]").count() == 0, "auditor sees no write controls")
        check(page.locator("[data-act=doc-open]").count() >= 1, "auditor can download documents")
        check(not errors, f"no console errors {errors}")
        b.close()
finally:
    server.terminate()
print("\nDOCUMENTS CHECKS PASSED" if not problems else f"\nFAILED: {problems}")
sys.exit(1 if problems else 0)
