"""Shared waits for the browser checks. No fixed sleeps: the app tells us when it is ready (public/core/ready.js).

  <html data-ready="loading|ready">  ready only while no request or data load is in flight
  window.__appReady                  true once (also available to scripts and to App.ready) the shell and the first view have loaded
  <html data-route="#/sales">        the route of the last render
"""

# Selectors, not wait_for_function: the app sends a strict CSP (no unsafe-eval) and Playwright evaluates predicates with eval.
READY_SEL = "html[data-ready='ready']"  # core/ready.js keeps this at 'loading' until window.__appReady is true


def ready(page, timeout=15000):
    """Wait until the shell and the current view finished loading and nothing is in flight."""
    page.wait_for_selector(READY_SEL, state='attached', timeout=timeout)


def go(page, hash_, timeout=15000):
    """Navigate inside the app by hash and wait for that route to be rendered and idle."""
    page.evaluate("h => { location.hash = h }", hash_)
    page.wait_for_selector(f"html[data-route='{hash_ or '#/'}']", state='attached', timeout=timeout)
    ready(page, timeout)


def open_app(page, url, timeout=15000):
    """page.goto(url) and wait for readiness (never for a selector that might race a re-render)."""
    page.goto(url)
    ready(page, timeout)


def stable(page, selector, timeout=5000):
    """Wait until an element stops moving or resizing (CSS transitions), measured over animation frames."""
    page.evaluate("""([sel, ms]) => new Promise((resolve, reject) => {
      const el = document.querySelector(sel); if (!el) return reject(new Error('no ' + sel));
      let last = '', same = 0; const end = performance.now() + ms;
      const tick = () => { const r = JSON.stringify(el.getBoundingClientRect()); same = r === last ? same + 1 : 0; last = r;
        if (same >= 3) return resolve(true); if (performance.now() > end) return reject(new Error('not stable: ' + sel)); requestAnimationFrame(tick); };
      tick();
    })""", [selector, timeout])
