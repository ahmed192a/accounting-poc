"""Regenerate docs/img/*.png and docs/img/demo.mp4 from a fresh demo server.
Usage: python3 scripts/capture-media.py   (needs Playwright + ffmpeg)"""
import os, subprocess, time, glob, shutil, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG = os.path.join(ROOT, "docs", "img"); os.makedirs(IMG, exist_ok=True)
PORT = os.environ.get("POC_PORT", "3150")
TMP = os.path.join(ROOT, ".video-tmp"); shutil.rmtree(TMP, ignore_errors=True)
srv = subprocess.Popen(["node", "--no-warnings", "src/server.js"], cwd=ROOT, env={**os.environ, "PORT": PORT})
for _ in range(50):
    try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/demo-users"); break
    except Exception: time.sleep(0.1)

import json
def api(method, path, uid, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json", "x-user-id": str(uid)})
    try: return json.load(urllib.request.urlopen(req))
    except Exception as e: print("seed warning", path, e); return None
def seed():
    """A little demo data so the dashboards have something to show."""
    for q in (3, 5, 2, 4):
        api("POST", "/api/sales/quick", 3, {"items": [{"sku": "TEA-250", "qty": q}, {"sku": "RICE-1K", "qty": q}]})
    api("POST", "/api/invoices", 3, {"customer": "Nile Traders", "lines": [{"description": "Black tea 250g x100", "qty": 100, "unitPrice": 4500}]})
    api("POST", "/api/invoices", 3, {"customer": "Delta Mini Market", "lines": [{"description": "Rice 1kg x60", "qty": 60, "unitPrice": 3200}]})
    api("POST", "/api/bills", 3, {"supplier": "Cairo Wholesale", "amount": 250000, "category": "purchases"})
seed()
# (user id, file name, text to wait for)
TOUR = [("3", "cashier", ".role-line"), ("2", "clerk", ".role-line"), ("1", "manager", ".role-line"),
        ("4", "accountant", ".role-line"), ("5", "owner", ".role-line"), ("6", "admin", ".role-line")]
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1280, "height": 800}, record_video_dir=TMP,
                            record_video_size={"width": 1280, "height": 800})
        page = ctx.new_page(); page.goto(f"http://127.0.0.1:{PORT}/"); page.wait_for_selector(".role-line")
        for uid, name, sel in TOUR:
            page.select_option("#user", uid); page.wait_for_selector(sel); page.wait_for_timeout(1200)
            page.screenshot(path=f"{IMG}/role-{name}.png")
        # owner tour of the main pages (the shell groups cards into pages)
        page.select_option("#user", "1"); page.wait_for_timeout(1200)
        for route in ["sales", "inventory", "banking", "reports", "tax", "entities", "ledger"]:
            page.evaluate("r => { location.hash = '#/' + r }", route); page.wait_for_timeout(1400)
            page.screenshot(path=f"{IMG}/page-{route}.png", full_page=False)
        page.evaluate("() => { location.hash = '#/' }"); page.wait_for_timeout(600)
        page.click("#lang"); page.wait_for_timeout(1500); page.screenshot(path=f"{IMG}/arabic-rtl.png")
        page.click("#lang"); page.wait_for_timeout(800)
        ctx.close(); b.close()
finally:
    srv.terminate()
vid = glob.glob(f"{TMP}/*.webm")[0]
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", vid, "-vf", "scale=1024:-2", "-c:v", "libx264",
                "-pix_fmt", "yuv420p", "-crf", "30", "-preset", "veryfast", f"{IMG}/demo.mp4"], check=True)
shutil.rmtree(TMP, ignore_errors=True)
print("wrote", IMG)
