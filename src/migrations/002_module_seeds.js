// Remembers which modules have already run their seed(), so a persistent database is seeded once
// and a module added later still gets seeded on its first startup.
export const id = '002_module_seeds';

export function up(db) {
  db.exec(`
    CREATE TABLE module_seeds (
      module TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}
