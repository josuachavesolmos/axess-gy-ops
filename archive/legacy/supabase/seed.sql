-- ============================================================
-- Seed data — Lookup tables
-- Ejecutar despues de schema.sql
-- ============================================================

-- Statuses: Personnel
INSERT INTO statuses (module, value, color) VALUES
  ('personnel', 'Planned', '#3b82f6'),
  ('personnel', 'Confirmed', '#7ab800'),
  ('personnel', 'On Site', '#009aa6'),
  ('personnel', 'Completed', '#6b7280'),
  ('personnel', 'Cancelled', '#ef4444'),
  ('personnel', 'Standby', '#f59e0b');

-- Statuses: Equipment
INSERT INTO statuses (module, value, color) VALUES
  ('equipment', 'Available', '#7ab800'),
  ('equipment', 'Deployed', '#009aa6'),
  ('equipment', 'In Transit', '#f59e0b'),
  ('equipment', 'Maintenance', '#e98300'),
  ('equipment', 'Out of Service', '#ef4444');

-- Statuses: Quote
INSERT INTO statuses (module, value, color) VALUES
  ('quote', 'Draft', '#6b7280'),
  ('quote', 'Sent', '#3b82f6'),
  ('quote', 'Won', '#7ab800'),
  ('quote', 'Lost', '#ef4444'),
  ('quote', 'Expired', '#f59e0b'),
  ('quote', 'Cancelled', '#9ca3af');

-- Statuses: Project
INSERT INTO statuses (module, value, color) VALUES
  ('project', 'Open', '#3b82f6'),
  ('project', 'In Progress', '#009aa6'),
  ('project', 'Pending Invoice', '#f59e0b'),
  ('project', 'Closed', '#6b7280'),
  ('project', 'On Hold', '#e98300');

-- Support Classifications
INSERT INTO support_classifications (value) VALUES
  ('Inspection'), ('Maintenance'), ('Repair'), ('Installation'),
  ('Commissioning'), ('Consulting'), ('Training'), ('Emergency');

-- Segments
INSERT INTO segments (value) VALUES
  ('Subsea'), ('Drilling'), ('Well Services'), ('Marine'),
  ('Wind'), ('Renewables'), ('Decommissioning');

-- Equipment Categories
INSERT INTO equipment_categories (value) VALUES
  ('ROV Equipment'), ('Inspection Tools'), ('NDT Equipment'),
  ('Lifting Equipment'), ('Safety Equipment'), ('Diving Equipment'),
  ('Calibration Tools'), ('General Tools');

-- Budget Forecast 2025
INSERT INTO budget_forecast (month, year, budget_revenue, forecast_order_backlog, variance) VALUES
  ('Jan', 2025, 150000, 120000, -30000),
  ('Feb', 2025, 160000, 145000, -15000),
  ('Mar', 2025, 175000, 170000, -5000),
  ('Apr', 2025, 180000, 185000, 5000),
  ('May', 2025, 200000, 195000, -5000),
  ('Jun', 2025, 220000, 230000, 10000),
  ('Jul', 2025, 210000, 205000, -5000),
  ('Aug', 2025, 230000, 240000, 10000),
  ('Sep', 2025, 215000, 210000, -5000),
  ('Oct', 2025, 240000, 250000, 10000),
  ('Nov', 2025, 225000, 220000, -5000),
  ('Dec', 2025, 200000, 190000, -10000);
