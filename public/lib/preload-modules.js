/* Classic async script: as soon as the list of UI modules arrives (the request is preloaded by index.html), ask the browser to
   fetch them with <link rel="modulepreload">, in parallel with the shell. core/boot.js still imports them in the usual way, so
   if this script or the list fails nothing changes except speed. Not an ES module on purpose: it must not wait for the shell graph. */
fetch('/api/ui-modules', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : [])).then((files) => {
  if (!Array.isArray(files)) return;
  const extra = ['/offline-queue.js']; // imported by modules/offline.js: preloading it removes one request level
  for (const u of extra) { const l = document.createElement('link'); l.rel = 'modulepreload'; l.href = u; document.head.appendChild(l); }
  for (const f of files) {
    if (typeof f !== 'string' || !/^[\w.-]+\.js$/.test(f)) continue;
    const l = document.createElement('link'); l.rel = 'modulepreload'; l.href = '/modules/' + f; document.head.appendChild(l);
  }
}).catch(() => {});
