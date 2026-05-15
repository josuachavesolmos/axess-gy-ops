-- ============================================================
-- Axess GY Dashboard v5.1 — D1 (SQLite) initial schema
-- ============================================================
-- This file is idempotent: drop + recreate. Re-running it wipes
-- all dashboard data but keeps the USERS KV (auth) untouched.
--
-- Apply with:
--   npx wrangler d1 execute axess-gy --remote --file=migrations/001_initial.sql
-- ============================================================

-- ─── audit / import tracking ────────────────────────────────
DROP TABLE IF EXISTS import_batches;
CREATE TABLE import_batches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset         TEXT    NOT NULL CHECK (dataset IN ('quote','personnel','equipment','master','leads')),
  filename        TEXT,
  row_count       INTEGER NOT NULL,
  imported_by     TEXT    NOT NULL,
  imported_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  meta_json       TEXT
);
CREATE INDEX idx_import_batches_dataset ON import_batches(dataset, imported_at DESC);
CREATE INDEX idx_import_batches_user    ON import_batches(imported_by, imported_at DESC);

-- ─── Master Projects ────────────────────────────────────────
DROP TABLE IF EXISTS master_projects;
CREATE TABLE master_projects (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  workorder           TEXT    NOT NULL,
  client              TEXT,
  scope               TEXT,
  installation        TEXT,
  po_number           TEXT,
  po_value            REAL,
  project_manager     TEXT,
  contract_manager    TEXT,
  client_pm           TEXT,
  status              TEXT,
  period              TEXT,
  start_date          TEXT,                       -- ISO YYYY-MM-DD
  end_date            TEXT,
  revenue_to_date     REAL,
  cost_to_date        REAL,
  cmr_to_date         REAL,
  -- QA Assurance 000-900 (one of: Completed, Under preparation,
  -- Not completed, Scope ongoing, Scope planned, Not applicable, or NULL)
  qa_000              TEXT, qa_100  TEXT, qa_200  TEXT, qa_300  TEXT, qa_400  TEXT,
  qa_500              TEXT, qa_600  TEXT, qa_700  TEXT, qa_800  TEXT, qa_900  TEXT,
  comment             TEXT,
  invoicing_status    TEXT,
  import_batch_id     INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_master_workorder   ON master_projects(workorder);
CREATE INDEX idx_master_status      ON master_projects(status);
CREATE INDEX idx_master_client      ON master_projects(client);
CREATE INDEX idx_master_period      ON master_projects(period);
CREATE INDEX idx_master_dates       ON master_projects(start_date, end_date);
CREATE INDEX idx_master_batch       ON master_projects(import_batch_id);

-- ─── Personnel assignments (Planner sheet) ──────────────────
DROP TABLE IF EXISTS personnel_assignments;
CREATE TABLE personnel_assignments (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  technician_name         TEXT    NOT NULL,
  competency              TEXT,
  start_date              TEXT    NOT NULL,
  duration_days           INTEGER,
  end_date                TEXT,
  installation            TEXT,
  client                  TEXT,
  status                  TEXT,
  work_order              TEXT,
  support_classification  TEXT,
  scope                   TEXT,
  import_batch_id         INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  created_at              TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_personnel_dates  ON personnel_assignments(start_date, end_date);
CREATE INDEX idx_personnel_status ON personnel_assignments(status);
CREATE INDEX idx_personnel_tech   ON personnel_assignments(technician_name);
CREATE INDEX idx_personnel_wo     ON personnel_assignments(work_order);
CREATE INDEX idx_personnel_batch  ON personnel_assignments(import_batch_id);

-- ─── Equipment assignments (Equipment planner + Lists join) ─
DROP TABLE IF EXISTS equipment_assignments;
CREATE TABLE equipment_assignments (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  description             TEXT    NOT NULL,    -- "Description & ID" column from Excel
  start_date              TEXT    NOT NULL,
  end_date                TEXT,
  installation            TEXT,
  client                  TEXT,
  status                  TEXT,
  work_order              TEXT,
  scope                   TEXT,
  calibration_due_date    TEXT,                -- from Lists sheet, joined by Equipment type
  equipment_status        TEXT,                -- from Lists sheet
  import_batch_id         INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  created_at              TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_equipment_dates       ON equipment_assignments(start_date, end_date);
CREATE INDEX idx_equipment_calibration ON equipment_assignments(calibration_due_date);
CREATE INDEX idx_equipment_status      ON equipment_assignments(status);
CREATE INDEX idx_equipment_wo          ON equipment_assignments(work_order);
CREATE INDEX idx_equipment_batch       ON equipment_assignments(import_batch_id);

-- ─── Quotes (Order Backlog) ─────────────────────────────────
DROP TABLE IF EXISTS quotes;
CREATE TABLE quotes (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id                 TEXT,                          -- "ID" from Excel
  title                       TEXT,
  entity                      TEXT,
  job_title                   TEXT,
  installation                TEXT,
  customer                    TEXT,
  status                      TEXT,
  responsible                 TEXT,
  segment                     TEXT,
  created_by                  TEXT,
  quote_date                  TEXT,
  validity_days               INTEGER,
  validity_date               TEXT,
  sent_date                   TEXT,
  estimated_start_date        TEXT,
  estimated_duration          TEXT,
  accepted_rejected_date      TEXT,
  probability                 INTEGER,
  out_ref                     TEXT,
  quote_revision              TEXT,
  client_ref                  TEXT,
  client_request_id           TEXT,
  currency                    TEXT,
  exchange_rate               REAL,
  price_list                  TEXT,
  axess_product               TEXT,
  incoterms                   TEXT,
  delivery_conditions         TEXT,
  sum_total                   REAL,
  sum_total_base_currency     REAL,
  weighted_probability_sum    REAL,
  cost_sum_total              REAL,
  cm_total                    REAL,
  cmr_total                   REAL,
  approver                    TEXT,
  approval_due_date           TEXT,
  workspace_url               TEXT,
  created_excel               TEXT,                          -- "Created" from Excel
  modified_excel              TEXT,                          -- "Modified"
  modified_by                 TEXT,
  import_batch_id             INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  created_at                  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_quotes_status    ON quotes(status);
CREATE INDEX idx_quotes_date      ON quotes(quote_date);
CREATE INDEX idx_quotes_customer  ON quotes(customer);
CREATE INDEX idx_quotes_segment   ON quotes(segment);
CREATE INDEX idx_quotes_external  ON quotes(external_id);
CREATE INDEX idx_quotes_batch     ON quotes(import_batch_id);

-- ─── Leads ──────────────────────────────────────────────────
DROP TABLE IF EXISTS leads;
CREATE TABLE leads (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  created             TEXT,                                 -- ISO datetime from Excel
  title               TEXT,
  responsible         TEXT,
  entity              TEXT,
  status              TEXT,
  due_date            TEXT,
  installation        TEXT,
  customer            TEXT,
  head_customer       TEXT,
  segment             TEXT,
  service             TEXT,
  customer_id         TEXT,
  head_customer_id    TEXT,
  installation_id     TEXT,
  entity_id           TEXT,
  created_by          TEXT,
  modified_by         TEXT,
  item_type           TEXT,
  path                TEXT,
  import_batch_id     INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  imported_at         TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_leads_status     ON leads(status);
CREATE INDEX idx_leads_date       ON leads(created);
CREATE INDEX idx_leads_customer   ON leads(customer);
CREATE INDEX idx_leads_segment    ON leads(segment);
CREATE INDEX idx_leads_responsible ON leads(responsible);
CREATE INDEX idx_leads_batch      ON leads(import_batch_id);

-- ─── Views: "current snapshot" for each dataset ─────────────
-- The Worker queries these views to hydrate the dashboard. They
-- always reflect the rows belonging to the most recent batch for
-- each dataset, so partial uploads or rollbacks are atomic.

DROP VIEW IF EXISTS v_master_current;
CREATE VIEW v_master_current AS
SELECT mp.*
FROM master_projects mp
JOIN (
  SELECT id FROM import_batches WHERE dataset = 'master' ORDER BY imported_at DESC LIMIT 1
) latest ON mp.import_batch_id = latest.id;

DROP VIEW IF EXISTS v_personnel_current;
CREATE VIEW v_personnel_current AS
SELECT pa.*
FROM personnel_assignments pa
JOIN (
  SELECT id FROM import_batches WHERE dataset = 'personnel' ORDER BY imported_at DESC LIMIT 1
) latest ON pa.import_batch_id = latest.id;

DROP VIEW IF EXISTS v_equipment_current;
CREATE VIEW v_equipment_current AS
SELECT ea.*
FROM equipment_assignments ea
JOIN (
  SELECT id FROM import_batches WHERE dataset = 'equipment' ORDER BY imported_at DESC LIMIT 1
) latest ON ea.import_batch_id = latest.id;

DROP VIEW IF EXISTS v_quotes_current;
CREATE VIEW v_quotes_current AS
SELECT q.*
FROM quotes q
JOIN (
  SELECT id FROM import_batches WHERE dataset = 'quote' ORDER BY imported_at DESC LIMIT 1
) latest ON q.import_batch_id = latest.id;

DROP VIEW IF EXISTS v_leads_current;
CREATE VIEW v_leads_current AS
SELECT l.*
FROM leads l
JOIN (
  SELECT id FROM import_batches WHERE dataset = 'leads' ORDER BY imported_at DESC LIMIT 1
) latest ON l.import_batch_id = latest.id;
