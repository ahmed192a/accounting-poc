// Pure keyboard shortcut state machine. Feed it simplified key events; it returns an action or null.
//   Ctrl/Cmd+K or "/" -> palette, "?" -> help, "[" -> toggleNav, "g" then 1-9 (or "h") -> goto index.
export function createShortcuts({ timeout = 1200 } = {}) {
  let pendingG = 0;
  return {
    handle(ev, now = 0) {
      const key = String(ev.key ?? '');
      if ((ev.ctrlKey || ev.metaKey) && key.toLowerCase() === 'k' && !ev.altKey) { pendingG = 0; return { action: 'palette' }; }
      if (ev.typing || ev.ctrlKey || ev.metaKey || ev.altKey) { pendingG = 0; return null; }
      if (pendingG && now - pendingG <= timeout) {
        pendingG = 0;
        if (/^[1-9]$/.test(key)) return { action: 'goto', index: Number(key) - 1 };
        if (key.toLowerCase() === 'h') return { action: 'goto', index: 0 };
        return null;
      }
      pendingG = 0;
      if (key === 'g') { pendingG = now || 1; return null; }
      if (key === '/') return { action: 'palette' };
      if (key === '?') return { action: 'help' };
      if (key === '[') return { action: 'toggleNav' };
      return null;
    },
  };
}
