// Reference: the owner placeholder user (id 1). Every company needs one; the first-run setup or tenant provisioning
// gives it a real name, e-mail and password. The built-in roles already exist: initContext syncs them before any seed runs.
export function seed(ctx) {
  ctx.db.prepare("INSERT INTO users (name, role_id) VALUES ('Owner', (SELECT id FROM roles WHERE name = 'owner'))").run();
}

const DEMO_USERS = [
  ['Karim (manager)', 'manager'],
  ['Sara (clerk)', 'clerk'],
  ['Hossam (accountant)', 'accountant'],
  ['Laila (auditor)', 'auditor'],
  ['Omar (admin / developer)', 'admin'],
];

// Demo: the six people the demo switcher shows (ids 1 to 6). Mona is the owner placeholder renamed.
export function demoSeed(ctx) {
  ctx.db.prepare("UPDATE users SET name = 'Mona (owner)' WHERE id = 1 AND name = 'Owner'").run();
  const user = ctx.db.prepare('INSERT INTO users (name, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))');
  DEMO_USERS.forEach((u) => user.run(...u));
}
