// The App object handed to every UI module. Created empty here so any shell file can import it without cycles;
// core/app.js fills it in (docs/ARCHITECTURE.md lists the members).
export const App = {};

export const $ = (id) => document.getElementById(id);

/** View model shared by the render files (kept in one object because ES module bindings cannot be reassigned by importers). */
export const view = {
  entries: [],        // visible, non-empty cards with their html
  pages: [],          // built from entries + full pages
  installPrompt: null,
  pendingCard: null,  // card id to scroll to after the next render (command palette)
};
