# Axess GY Ops

Operations platform for Axess Guyana — dashboard with Supabase backend.

## Architecture

```
Dashboard (HTML/JS) ──→ Supabase REST API ──→ PostgreSQL
                         (auto-generated)
```

## Modules

- **Personnel** — Technician assignments, Gantt planning, competency tracking
- **Equipment** — Asset management, calibration tracking, deployment history
- **Quote Log** — Sales pipeline, probability tracking, revenue forecasting
- **Master Project** — Work orders, invoicing, project status

## Database Setup

1. Create a project at [supabase.com](https://supabase.com)
2. Go to SQL Editor and run:
   - `supabase/schema.sql` — creates all tables, indexes, triggers, and RLS policies
   - `supabase/seed.sql` — populates lookup tables (statuses, classifications, categories)
3. Copy your project URL and anon key to the dashboard config

## Stack

- **Frontend:** HTML + CSS + vanilla JS (single-file dashboard)
- **Backend:** Supabase (PostgreSQL + auto-generated REST API)
- **Hosting:** GitHub Pages
- **Embed:** SharePoint iframe
