-- ============================================================
-- Axess GY Operations — Database Schema
-- Supabase (PostgreSQL)
-- ============================================================

-- ======================== LOOKUP TABLES ========================

-- Tabla de estados reutilizable por modulo
CREATE TABLE statuses (
  id SERIAL PRIMARY KEY,
  module TEXT NOT NULL CHECK (module IN ('personnel', 'equipment', 'quote', 'project')),
  value TEXT NOT NULL,
  color TEXT,
  UNIQUE(module, value)
);

-- Clientes
CREATE TABLE clients (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  company TEXT,
  phone TEXT,
  email TEXT,
  location TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Instalaciones (rigs, plataformas, etc.)
CREATE TABLE installations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  client_id INTEGER REFERENCES clients(id),
  location TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Clasificaciones de soporte
CREATE TABLE support_classifications (
  id SERIAL PRIMARY KEY,
  value TEXT NOT NULL UNIQUE
);

-- Segmentos de negocio
CREATE TABLE segments (
  id SERIAL PRIMARY KEY,
  value TEXT NOT NULL UNIQUE
);

-- ======================== PERSONNEL ========================

CREATE TABLE technicians (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  competency TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE personnel_assignments (
  id SERIAL PRIMARY KEY,
  technician_id INTEGER NOT NULL REFERENCES technicians(id),
  start_date DATE NOT NULL,
  duration_days INTEGER,
  end_date DATE,
  installation_id INTEGER REFERENCES installations(id),
  client_id INTEGER REFERENCES clients(id),
  status TEXT NOT NULL DEFAULT 'Planned',
  work_order TEXT,
  support_classification_id INTEGER REFERENCES support_classifications(id),
  scope TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ======================== EQUIPMENT ========================

CREATE TABLE equipment_categories (
  id SERIAL PRIMARY KEY,
  value TEXT NOT NULL UNIQUE
);

CREATE TABLE equipment (
  id SERIAL PRIMARY KEY,
  description TEXT NOT NULL,
  equipment_id_code TEXT,
  category_id INTEGER REFERENCES equipment_categories(id),
  calibration_due_date DATE,
  calibration_status TEXT CHECK (calibration_status IN ('Valid', 'Due Soon', 'Expired', 'N/A')),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE equipment_assignments (
  id SERIAL PRIMARY KEY,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  start_date DATE NOT NULL,
  end_date DATE,
  installation_id INTEGER REFERENCES installations(id),
  client_id INTEGER REFERENCES clients(id),
  status TEXT NOT NULL DEFAULT 'Available',
  work_order TEXT,
  scope TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ======================== QUOTE LOG ========================

CREATE TABLE quotes (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  entity TEXT,
  job_title TEXT,
  installation_id INTEGER REFERENCES installations(id),
  customer_id INTEGER REFERENCES clients(id),
  status TEXT NOT NULL DEFAULT 'Draft',
  responsible TEXT,
  segment_id INTEGER REFERENCES segments(id),
  created_by TEXT,
  quote_date DATE,
  validity INTEGER, -- dias
  validity_date DATE,
  sent_date DATE,
  estimated_start_date DATE,
  estimated_duration TEXT,
  accepted_rejected_date DATE,
  probability INTEGER CHECK (probability BETWEEN 0 AND 100),
  out_ref TEXT,
  quote_revision TEXT,
  client_ref TEXT,
  client_request_id TEXT,
  currency TEXT DEFAULT 'USD',
  exchange_rate NUMERIC(12,4),
  price_list TEXT,
  axess_product TEXT,
  incoterms TEXT,
  delivery_conditions TEXT,
  sum_total NUMERIC(14,2),
  sum_total_base_currency NUMERIC(14,2),
  weighted_probability_sum NUMERIC(14,2),
  cost_sum_total NUMERIC(14,2),
  cm_total NUMERIC(14,2),
  cmr_total NUMERIC(14,2),
  approver TEXT,
  approval_due_date DATE,
  workspace_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ======================== MASTER PROJECT ========================

CREATE TABLE projects (
  id SERIAL PRIMARY KEY,
  work_order_number TEXT,
  po_number TEXT,
  po_value NUMERIC(14,2),
  pending_invoice_value NUMERIC(14,2),
  description TEXT,
  responsible TEXT,
  installation_id INTEGER REFERENCES installations(id),
  client_id INTEGER REFERENCES clients(id),
  client_pm TEXT,
  project_close_date DATE,
  last_update DATE,
  expected_turnaround INTEGER, -- dias
  actual_days_waiting INTEGER,
  recent_updates TEXT,
  invoice_issued BOOLEAN DEFAULT false,
  date_invoice_accepted DATE,
  payment_due_date DATE,
  status TEXT DEFAULT 'Open',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ======================== BUDGET / FORECAST ========================

CREATE TABLE budget_forecast (
  id SERIAL PRIMARY KEY,
  month TEXT NOT NULL,
  year INTEGER NOT NULL DEFAULT 2025,
  budget_revenue NUMERIC(14,2),
  forecast_order_backlog NUMERIC(14,2),
  variance NUMERIC(14,2),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(month, year)
);

-- ======================== INDEXES ========================

CREATE INDEX idx_personnel_dates ON personnel_assignments(start_date, end_date);
CREATE INDEX idx_personnel_status ON personnel_assignments(status);
CREATE INDEX idx_equipment_assign_dates ON equipment_assignments(start_date, end_date);
CREATE INDEX idx_equipment_calibration ON equipment(calibration_due_date);
CREATE INDEX idx_quotes_status ON quotes(status);
CREATE INDEX idx_quotes_date ON quotes(quote_date);
CREATE INDEX idx_projects_status ON projects(status);

-- ======================== AUTO-UPDATE TIMESTAMPS ========================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_personnel_updated_at
  BEFORE UPDATE ON personnel_assignments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_equipment_updated_at
  BEFORE UPDATE ON equipment_assignments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_quotes_updated_at
  BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ======================== ROW LEVEL SECURITY ========================

ALTER TABLE personnel_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE technicians ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE installations ENABLE ROW LEVEL SECURITY;

-- Politica publica de lectura (ajustar segun necesidad de auth)
CREATE POLICY "Allow public read" ON personnel_assignments FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON equipment_assignments FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON quotes FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON projects FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON technicians FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON equipment FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON clients FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON installations FOR SELECT USING (true);

-- Politica publica de escritura (ajustar cuando agregues auth)
CREATE POLICY "Allow public write" ON personnel_assignments FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public write" ON equipment_assignments FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public write" ON quotes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public write" ON projects FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public write" ON technicians FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public write" ON equipment FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public write" ON clients FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public write" ON installations FOR ALL USING (true) WITH CHECK (true);
