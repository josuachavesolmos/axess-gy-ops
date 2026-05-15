-- ============================================================
-- Migration 002 — Relax NOT NULL constraints
-- ============================================================
-- Original schema marked start_date / technician_name / description
-- as NOT NULL. Real Excel uploads sometimes have these fields empty
-- (rows pending data entry), which made the entire bulk insert
-- rollback. We move to nullable + let the dashboard filter at render.
--
-- SQLite cannot ALTER a column to DROP NOT NULL, so we recreate the
-- two affected tables.
-- ============================================================

-- ─── personnel_assignments ──────────────────────────────────
ALTER TABLE personnel_assignments RENAME TO personnel_assignments_old;

CREATE TABLE personnel_assignments (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  technician_name         TEXT,                  -- was NOT NULL
  competency              TEXT,
  start_date              TEXT,                  -- was NOT NULL
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

INSERT INTO personnel_assignments SELECT * FROM personnel_assignments_old;
DROP TABLE personnel_assignments_old;

CREATE INDEX idx_personnel_dates  ON personnel_assignments(start_date, end_date);
CREATE INDEX idx_personnel_status ON personnel_assignments(status);
CREATE INDEX idx_personnel_tech   ON personnel_assignments(technician_name);
CREATE INDEX idx_personnel_wo     ON personnel_assignments(work_order);
CREATE INDEX idx_personnel_batch  ON personnel_assignments(import_batch_id);

-- View must be re-created (depends on the table)
DROP VIEW IF EXISTS v_personnel_current;
CREATE VIEW v_personnel_current AS
SELECT pa.*
FROM personnel_assignments pa
JOIN (
  SELECT id FROM import_batches WHERE dataset = 'personnel' ORDER BY imported_at DESC LIMIT 1
) latest ON pa.import_batch_id = latest.id;

-- ─── equipment_assignments ─────────────────────────────────
ALTER TABLE equipment_assignments RENAME TO equipment_assignments_old;

CREATE TABLE equipment_assignments (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  description             TEXT,                  -- was NOT NULL
  start_date              TEXT,                  -- was NOT NULL
  end_date                TEXT,
  installation            TEXT,
  client                  TEXT,
  status                  TEXT,
  work_order              TEXT,
  scope                   TEXT,
  calibration_due_date    TEXT,
  equipment_status        TEXT,
  import_batch_id         INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  created_at              TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO equipment_assignments SELECT * FROM equipment_assignments_old;
DROP TABLE equipment_assignments_old;

CREATE INDEX idx_equipment_dates       ON equipment_assignments(start_date, end_date);
CREATE INDEX idx_equipment_calibration ON equipment_assignments(calibration_due_date);
CREATE INDEX idx_equipment_status      ON equipment_assignments(status);
CREATE INDEX idx_equipment_wo          ON equipment_assignments(work_order);
CREATE INDEX idx_equipment_batch       ON equipment_assignments(import_batch_id);

DROP VIEW IF EXISTS v_equipment_current;
CREATE VIEW v_equipment_current AS
SELECT ea.*
FROM equipment_assignments ea
JOIN (
  SELECT id FROM import_batches WHERE dataset = 'equipment' ORDER BY imported_at DESC LIMIT 1
) latest ON ea.import_batch_id = latest.id;

-- ─── master_projects.workorder also relaxed (some rows have empty WO) ──
ALTER TABLE master_projects RENAME TO master_projects_old;

CREATE TABLE master_projects (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  workorder           TEXT,                       -- was NOT NULL
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
  start_date          TEXT,
  end_date            TEXT,
  revenue_to_date     REAL,
  cost_to_date        REAL,
  cmr_to_date         REAL,
  qa_000              TEXT, qa_100  TEXT, qa_200  TEXT, qa_300  TEXT, qa_400  TEXT,
  qa_500              TEXT, qa_600  TEXT, qa_700  TEXT, qa_800  TEXT, qa_900  TEXT,
  comment             TEXT,
  invoicing_status    TEXT,
  import_batch_id     INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO master_projects SELECT * FROM master_projects_old;
DROP TABLE master_projects_old;

CREATE INDEX idx_master_workorder   ON master_projects(workorder);
CREATE INDEX idx_master_status      ON master_projects(status);
CREATE INDEX idx_master_client      ON master_projects(client);
CREATE INDEX idx_master_period      ON master_projects(period);
CREATE INDEX idx_master_dates       ON master_projects(start_date, end_date);
CREATE INDEX idx_master_batch       ON master_projects(import_batch_id);

DROP VIEW IF EXISTS v_master_current;
CREATE VIEW v_master_current AS
SELECT mp.*
FROM master_projects mp
JOIN (
  SELECT id FROM import_batches WHERE dataset = 'master' ORDER BY imported_at DESC LIMIT 1
) latest ON mp.import_batch_id = latest.id;
