// Approvals engine: configurable rules -> ordered steps, requests with per-step state, delegation,
// full history and in-app notifications.
export const id = '710_approvals_engine';

export function up(db) {
  db.exec(`
    CREATE TABLE approvals_rules (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      doc_type TEXT NOT NULL CHECK (doc_type IN ('bill')),
      min_amount INTEGER NOT NULL DEFAULT 0,
      max_amount INTEGER,
      category TEXT,
      supplier_id INTEGER,
      mode TEXT NOT NULL CHECK (mode IN ('sequential','parallel')),
      priority INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE approvals_rule_steps (
      id INTEGER PRIMARY KEY,
      rule_id INTEGER NOT NULL REFERENCES approvals_rules(id),
      step_no INTEGER NOT NULL,
      approver_type TEXT NOT NULL CHECK (approver_type IN ('role','user','permission')),
      approver_ref TEXT NOT NULL,
      max_amount INTEGER,
      escalate_after_hours INTEGER,
      escalate_to_type TEXT CHECK (escalate_to_type IN ('role','user')),
      escalate_to_ref TEXT
    );

    CREATE TABLE approvals_requests (
      id INTEGER PRIMARY KEY,
      doc_type TEXT NOT NULL,
      doc_id INTEGER NOT NULL,
      rule_id INTEGER,
      rule_name TEXT,
      mode TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','cancelled')),
      created_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      reason TEXT
    );
    CREATE INDEX approvals_requests_doc ON approvals_requests(doc_type, doc_id);
    CREATE TABLE approvals_request_steps (
      id INTEGER PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES approvals_requests(id),
      step_no INTEGER NOT NULL,
      approver_type TEXT NOT NULL,
      approver_ref TEXT NOT NULL,
      max_amount INTEGER,
      status TEXT NOT NULL CHECK (status IN ('waiting','pending','approved','rejected','skipped')),
      activated_at INTEGER,
      due_at INTEGER,
      escalate_hours INTEGER,
      escalate_to_type TEXT,
      escalate_to_ref TEXT,
      escalated_at INTEGER,
      acted_by INTEGER,
      on_behalf_of INTEGER,
      acted_at INTEGER,
      comment TEXT
    );

    CREATE TABLE approvals_delegations (
      id INTEGER PRIMARY KEY,
      from_user INTEGER NOT NULL,
      to_user INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      reason TEXT,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE approvals_history (
      id INTEGER PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES approvals_requests(id),
      ts INTEGER NOT NULL,
      user_id INTEGER,
      action TEXT NOT NULL,
      detail TEXT
    );

    CREATE TABLE approvals_notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      ref_type TEXT,
      ref_id INTEGER,
      read_at INTEGER
    );
    CREATE INDEX approvals_notifications_user ON approvals_notifications(user_id, read_at);
  `);
}
