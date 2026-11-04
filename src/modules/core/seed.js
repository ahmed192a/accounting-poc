const USERS = [
  ['Mona (owner)', 'owner'],
  ['Karim (manager)', 'manager'],
  ['Sara (clerk)', 'clerk'],
  ['Hossam (accountant)', 'accountant'],
  ['Laila (auditor)', 'auditor'],
  ['Omar (admin / developer)', 'admin'],
];

// Demo users. The built-in roles already exist: initContext syncs them before any seed runs.
export function seed(ctx) {
  const user = ctx.db.prepare('INSERT INTO users (name, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))');
  USERS.forEach((u) => user.run(...u));
}
