// UI shell entry point. The shell is split into ES modules (no bundler); see docs/ARCHITECTURE.md "Client layout".
//   core/   state, i18n, registries, api, login, load, render, events, boot, readiness
//   ui/     chrome, page bodies, command palette, shell actions
//   lib/    pure logic (unit tested without a DOM) and DOM primitives
// Builds the App object, imports every public/modules/*.js file listed by GET /api/ui-modules, then renders.
// Owned by the UI shell owner: feature agents add a file under public/modules/ and never edit the shell.
import '/core/ready.js';
import '/core/app.js';
import '/core/events.js';
import { boot } from '/core/boot.js';

boot();
