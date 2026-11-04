import glob, os, subprocess, sys

# Runs every browser check in e2e/: ui_check.py, every *_check.py (for example shell_check.py) and
# smoke_all_modules.py, one after another, each on its own port (POC_PORT, POC_PORT+1, ...).
# Prints a summary and exits 1 if any script failed. Usage: python3 e2e/run_all.py
HERE = os.path.dirname(os.path.abspath(__file__))
base = int(os.environ.get("POC_PORT", "3100"))
names = sorted({os.path.basename(f) for f in glob.glob(os.path.join(HERE, "*_check.py"))} - {"ui_check.py"})
scripts = ["ui_check.py"] + names + ["smoke_all_modules.py"]
scripts = [s for s in scripts if os.path.exists(os.path.join(HERE, s))]
results = []
for i, name in enumerate(scripts):
    print(f"\n===== {name} (port {base + i}) =====", flush=True)
    r = subprocess.run([sys.executable, os.path.join(HERE, name)], env={**os.environ, "POC_PORT": str(base + i)})
    results.append((name, r.returncode))
print("\n===== e2e summary =====")
for name, code in results:
    print(("PASS " if code == 0 else "FAIL ") + name)
sys.exit(1 if any(c for _, c in results) else 0)
