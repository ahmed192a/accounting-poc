// Every database file knows which tenant it belongs to. The tenant manager (src/tenants.js) writes the rows
// when it provisions a tenant and refuses to open a file whose identity differs from the registry's record,
// so a file copied or renamed into the wrong slot can never be served as another company.
export const id = '900_tenant_info';

export function up(db) {
  db.exec('CREATE TABLE tenant_info (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}
