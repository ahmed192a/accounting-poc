export function seed(ctx) {
  // Bills up to 1,000 EGP post without approval.
  ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('bill_auto_approve', '100000')").run();
}
