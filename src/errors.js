export class AppError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// Validation helper shared by modules: money and quantities are positive whole numbers (piastres, units).
export function posInt(n, field) {
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, 'BAD_INPUT', `${field} must be a positive whole number`);
  return n;
}
