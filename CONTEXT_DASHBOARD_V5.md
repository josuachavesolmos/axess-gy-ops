# Axess GY · Dashboard V5 — Project Context

> Single-file operations dashboard for **Axess Group Guyana** (oil & gas field services).
> Audience: client = Axess GY ops; data = Excel uploads from SharePoint/Power BI exports.
> File: `Axess_GY_Dashboard_v5.html` (~5200 LOC, ~280 KB, monolithic).
> Templates: `templates/*.xlsx` are the **canonical schemas** the parser expects.

---

## 1. Goal & Scope

The dashboard is a **standalone, single-HTML, no-build** BI tool that ingests four Excel
sources and renders five operational lenses for the Guyana branch:

| Tab | Title in topbar | Source workbook | Upload pill |
|----|----|----|----|
| `quote` | Order Backlog & Revenue | `QuoteLog_*.xlsx` (standalone) | **Quote Log** |
| `personnel` | Personnel & Scheduling | `Axess_Unified_Workbook.xlsx` — sheet *Planner* | **Operations** |
| `equipment` | Equipment & Calibration | `Axess_Unified_Workbook.xlsx` — sheets *Equipment planner* + *Lists* | **Operations** |
| `master` | Work Orders & Billing | `Axess_Unified_Workbook.xlsx` — sheet *Master Projects* | **Operations** |
| `leads` | Leads Log | `Leads 2.xlsx` (standalone) | **Leads** |

Three upload pills as of 2026-05:

- **Operations** (`type='operations'`) — single workbook with the 3 operational
  datasets (*Master Projects* + *Planner* + *Equipment planner* + *Lists*).
  Loads only those 3 even if the file also has *Quote Log* / *Leads* sheets;
  the other pills own those.
- **Quote Log** (`type='quote'`) — standalone Quote Log export (sheet detected
  by `findQuoteSheet`).
- **Leads** (`type='leads'`) — standalone Leads export (sheet detected by
  `findLeadsSheet`).

No backend, no build step, no framework — runs from `file://` or any static host.
v5 is the production successor of v4 (`Axess_GY_Dashboard_v4.html`, `dashboard_v2.html`,
`Axess_GY_Dashboard.html` are legacy and only kept for QA diffing).

---

## 2. Runtime stack

CDN-pinned dependencies (declared in `<head>`):

- **ApexCharts** `4.3.0` — every chart (`apexcharts.min.js`)
- **SheetJS xlsx** `0.18.5` — Excel parsing in-browser (`xlsx.full.min.js`)
- **Google Fonts** — `JetBrains Mono` for numerics; Century Gothic / Trebuchet / Arial for body (system stack)
- No bundler, no transpiler, no module imports. All JS lives in a single `<script>` block.

Design tokens (CSS custom props, `:root`) follow the **Axess Graphic Profile Manual (2013)**:

```
--brand:#00636d  --brand-light:#009aa6  --brand-glow:#33b8c2
--warm:#e98300   --success:#7ab800      --info:#589199
--text:#111827   --text-2:#4D5357       --bg:#f0f2f5
```

Dark mode via `[data-theme="dark"]` swap on `<html>`, persisted in `localStorage`
under key `axess-theme`. Charts re-themed via `updateChartsTheme()` when toggled.
`prefers-reduced-motion` is respected on initial chart animations.

---

## 3. Layout / DOM landmarks

```
<aside.sidebar>            ← 5 tabs (role=tablist), brand, theme/collapse footer
<div.main>
  <div.mobile-nav>         ← duplicate tab buttons for ≤900 px
  <div.topbar>             ← title + 3 upload pills (Operations · Quote Log · Leads) + Export button
  <div.content>
    <div.tab-panel#panel-quote     class="active">
    <div.tab-panel#panel-personnel>
    <div.tab-panel#panel-equipment>
    <div.tab-panel#panel-master>
    <div.tab-panel#panel-leads>
<div.toast-container#toasts>
```

Each panel follows the same skeleton:
```
.filters-bar        ← year/from/to + per-tab dropdowns + Clear-All
.kpi-row#kpi-<tab>  ← rendered by renderKPIs()
.chart-grid#charts-<tab> or custom views (gantt, table, pipeline)
```

Tab switching: `switchTab(tab)` — toggles `.active` on panel + nav-item, updates
`#top-title` from a static map, and calls `renderTab(tab)`.

---

## 4. State model

All data lives in a single global `state` object:

```js
state = {
  quote:     { raw: [], filtered: [] },
  personnel: { raw: [], filtered: [] },
  equipment: { raw: [], filtered: [] },
  master:    { raw: [], filtered: [] },
  leads:     { raw: [], filtered: [] },
}
```

- `raw` = parsed rows from the Excel as-is (canonicalized for `master` only).
- `filtered` = current view after the filters bar — every render reads from `filtered`.
- `applyFilters(type)` mutates `state[type].filtered` and triggers a re-render.
- `resetFilters(type)` re-clones `raw` into `filtered`.

There is no Redux, no event bus, no reactivity layer. State changes are imperative
and re-render the whole tab DOM via `renderTab(type) → renderTabContent(type)`.

UI flags (module-level globals, not in `state`):

```
activeTab, personnelView, equipmentView,
personnelGanttScale ('month'|'week'|'day'),
personnelGanttHierarchy ('personnel'|'installation'|'scope'),
personnelGanttGroupBy, personnelGanttAggregate,
equipmentGanttScale, equipmentGanttHierarchy ('flat'|'client'),
quoteGroupBy, personnelGroupBy, personnelMandaysPage,
quoteTimePeriod ('week'|'month'|'year'),
masterView ('overview'|'pipeline'|'timeline'|'clients'),
masterOpsZero (date string)
```

---

## 5. Upload pipeline

User clicks one of the 3 `.upload-pill <input type=file>` → `handleUpload(input, type)`
where `type` is `'operations'`, `'quote'`, or `'leads'`:

1. `FileReader.readAsArrayBuffer` → `XLSX.read(data, { type:'array', cellDates:true })`
   (with `cellDates:false` fallback if the dates throw).
2. `detectDatasetsInWorkbook(wb)` inspects sheet names and returns which of the 5
   datasets are present (`quote/personnel/equipment/master/leads`). Match rules:
   - quote: any sheet name containing `quote`
   - personnel: sheet name === `Planner` (exact, case-insensitive)
   - equipment: any sheet name containing `equipment`
   - master: sheet matching `^master(\s+projects?)?$` OR containing `glass|guyana`
   - leads: sheet === `Leads` OR starting with `query`
3. Branching by `type`:
   - **`operations`** → runs `processMaster` / `processPersonnel` /
     `processEquipmentFromWorkbook` for whichever of the three are detected.
     Throws `"No Operations sheets found"` if none match. The 3 mini dots
     (`#dot-master`, `#dot-personnel`, `#dot-equipment`) inside the Operations
     pill flip to `loaded`. Quote and Leads are intentionally ignored even if
     present in the workbook — they have their own pills.
   - **`quote`** → runs `processQuote` (uses `findQuoteSheet`).
   - **`leads`** → runs `processLeads` (uses `findLeadsSheet`).
4. Toast summarises: `loaded · N datasets (a, b, c)` for multi-load operations,
   plain `loaded successfully` for single. Each loaded tab is re-rendered via
   `loaded.forEach(t => renderTab(t))` — this is what makes Operations refresh
   3 panels at once.

Parsers (each finds its own sheet, never relies on `SheetNames[0]` blindly):
- `processQuote(wb)` — uses `findQuoteSheet()` (first sheet containing `quote`, else `SheetNames[0]`).
- `processPersonnel(wb)` — finds sheet whose name === `planner`. Does **not** auto-cross-load Equipment (the branching in step 3 owns that).
- `processEquipment(wb)` / `processEquipmentFromWorkbook(wb)` — reads *Equipment planner* + joins calibration data from the *Lists* sheet keyed by `Equipment type`.
- `processMaster(wb)` — uses `findMasterSheet()` (master / master projects / glass / guyana), then scans first 45 rows for the actual header row containing `workorder`+`client|installation`, then normalizes every record via `normalizeMasterRecord()`.
- `processLeads(wb)` — uses `findLeadsSheet()` (`Leads` exact match, else fuzzy `lead`, else `query*`).

There is also a **demo seed path** (`demoLoad()` is invoked on first paint with hard-coded
sample rows so the dashboard is never empty) — see `state.*.raw = []; ... .raw.push(...)`
blocks around lines 953–1085.

---

## 6. Template schemas (canonical column names)

The parser reads these headers **literally** (`XLSX.utils.sheet_to_json` with default
behaviour, except Master which uses `header:1` + manual scan). Renaming columns in the
Excel will silently break the dashboard.

### 6.1 `QuoteLog_*.xlsx` → tab **quote**

Sheet: first one. 40 columns, ~393 rows (sample file).

Columns consumed:
```
Title, Entity, Job Title, Installation, Customer, Status,
Responsible, Workspace Url, Segment, Created By,
Quote Date, Validity, Validity Date, Sent Date,
Estimated Start Date, Estimated Project Duration,
Accepted/Rejected Date, Probability, Out Ref, Quote Revision,
Client Ref, Client Request ID, Currency, Exchange Rate,
Price List, Axess Product, Incoterms, Delivery Conditions,
Sum Total, Sum Total Base Currency,        ← revenue (base = NOK)
Weighted Probability Sum, Cost Sum Total,
CM Total, CMR Total,                        ← contribution margin
Approver, Approval Due Date, Created, Modified, Modified By, ID
```

KPIs derive from `Sum Total Base Currency`, `Cost Sum Total`, `Status` (Accepted /
Rejected / Open). Win Rate denominator = total quotes in the filtered view (fix
landed in commit `f6874ae`, 2026-05-07).

Filters: Year, From, To, Status, Segment, Customer, Responsible, Group by
(Segment | Customer | Status).

### 6.2 `Personnel_Planner_TEMPLATE.xlsx` → tab **personnel**

Sheet: **Planner** (`s.toLowerCase() === 'planner'`). Rows where `Technician Name`
is empty are dropped.

Columns:
```
Technician Name, Competency, Start Date, Duration (days), End Date,
Installation, Client, Status, Work Order, Support Classification, Scope
```

`Status` enum (must match exactly — colors live in `STATUS_COLORS`):
`Offshore | Onshore | Available | Training | Standby | Annual leave | Days Off | Travel`

Views: **Gantt** (default, scales `month|week|day`, hierarchies `personnel|installation|scope`,
optional aggregate mode), **Charts**, **Resources list**, **Mandays report** (paginated,
filterable by technician).

Vessel map: clicking a row in `pers-list-row.clickable` opens a VesselFinder iframe
(`buildVesselEmbedUrl` / `buildVesselSearchUrl`) — heuristic match by installation name.

### 6.3 `Personnel_Planner_TEMPLATE.xlsx` → tab **equipment**

Sheet: **Equipment planner** (`s.toLowerCase().includes('equipment')`). Rows where
`Description & ID` is empty are dropped.

Columns from *Equipment planner*:
```
Description & ID, Start Date, End Date, Installation, Client,
Status, Work Order, Scope
```

Calibration metadata is joined from sheet **Lists** (keyed by `Equipment type`):
```
Equipment type, Calibration due date, Equipment status
```

Resulting normalized record:
```
Equipment Name, Equipment ID (= Work Order), Category (''),
Status, Client, Installation, Start Date, End Date,
Calibration End Date, Work Order, Scope
```

Calibration semaphore (`getCalibStatus` / `calibLabel`):
- **Red** `expired` — cal date < today
- **Red** `critical` — within current month
- **Amber** `warning` — within next 3 months
- **Green** `ok` — > 3 months ahead
- `unknown` — missing

Filters: From, To, Status, Category, Installation, Client, **Calibration**
(`expired|critical|warning|ok`). The sidebar badge `#alert-equipment` lights up when
any calibration is `expired` or `critical`.

### 6.4 `Project master sheet.xlsx` → tab **master**

Sheet: **Master** (with a *Validation* sheet that's ignored by the parser).
Headers are **merged across two visual rows**: row 1 has section banners
(`Project overview`, `Quality assurance`, `Invoicing`); row 2 has the actual columns.
The parser scans rows 0–44 looking for the row that contains both `workorder` and
`client|installation` and uses that as the header row.

Real header row (currently row 2):
```
Client, Workorder, Scope description, Installation, PO number, PO Value,
Project Manager, Contract Manager, Client PM, Status, Period,
Start date, End date,
Revenue to date, Cost to date, CMR to date,
000, 100, 200, 300, 400, 500, 600, 700, 800, 900,   ← QA Assurance steps (under "Quality assurance" banner)
Comment,
Invoicing status
```

Each `000`…`900` cell is one of: `Completed`, `Under preparation`, `Not completed`,
`Scope ongoing`, `Scope planned`, `Not applicable` (or blank). Values are matched
case-insensitive and trimmed by `normalizeQAItemStatus()`.

`normalizeMasterRecord(obj)` maps these to canonical keys (the rest of the codebase
reads only canonical keys):
```
Client, Installation, Scope, PO number, PO Value (numeric),
Work Order Number, Invoice Value (← Revenue to date), CMR (← CMR to date),
PERIOD, Status, Recent Updates (mirror of Status),
Responsible/ Project Manager, Contract Manager, Client PM,
Start date, End date,
QA Status (← Compliance Status — legacy, kept for the Comment column),
Invoice Status (← Invoicing status),
000, 100, 200, 300, 400, 500, 600, 700, 800, 900,   ← preserved as strings
Reports uploaded, KOM registered, COM registered,                       ← legacy aliases
Timesheets uploaded, Client eval registered, JSA and PTW uploaded       ← legacy aliases
```

`masterNum()` accepts `$1,234.50`, `1 234,50`, `(1,234.50)` and other dirty money
formats.

Filters: **From, To** (date range — overlap of `[Start date, End date]` with the
selected interval, applies to **every** master sub-view), Status, Installation,
Client, Responsible, Period.

Views (`masterView`): **Overview** (default — KPIs + Pipeline kanban + QA compliance
radial + chart grid), **QA** (KPI compliance card + Invoice donut + per-WO QA grid
with one dot per step 000-900), **Timeline** (with optional `P. OPS 0` reference
line via `masterOpsZero`), **By client**.

### 6.5 `Leads 2.xlsx` → tab **leads**

Sheet: first one (in the sample it's named `query (2)` — a Power Query export). 19 columns,
~3604 rows.

Columns:
```
Created, Title, Responsible, Entity, Status, DueDate,
Installation, Customer, Head Customer, Segment, Service,
CustomerId, HeadCustomerId, InstallationId, EntityID,
Created By, Modified By, Item Type, Path
```

Filters: Year, From, To, Status, Responsible, Entity, Service, Segment.

---

## 7. Rendering surface (entry points by tab)

| Tab | Top-level renderer | Notable subroutines |
|----|----|----|
| quote | `renderQuote()` | `buildRevCostChart()` (drill-down 2026-05-04) |
| personnel | `renderPersonnel()` | `renderGantt()`, `renderPersonnelCharts()`, `renderPersonnelMandaysReport()`, `buildHierarchyBy{Personnel,Installation,Scope}{,Grouped}`, `buildAggregateHierarchyBy{Installation,Scope}` |
| equipment | `renderEquipment()` | `renderEquipmentGantt()`, `renderEquipmentSummaryTable()`, `renderEquipmentTable()`, `renderEquipmentCharts()` |
| master | `renderMaster()` | `renderMasterAltViews()`, `renderMasterTimelineChart()`, `updateMasterPipelineChips()`, `renderMasterOverviewPipeline()`, `renderMasterOverviewCompliance()`, `renderMasterQAView()`, `buildPersonnelWOIndex()`, `masterKanbanCardHtml(r, techByWO)`, `getMasterWOQA()`, `computeMasterQAComplianceRate()`, `normalizeQAItemStatus()` |
| leads | `renderLeads()` | `renderLeadsTable()` |

Shared building blocks:
- `renderKPIs(containerId, kpis[])` — cards with animated counter (`animateValue`).
- `buildChartGrid(containerId, chartDefs)` — creates one `.chart-card` per def.
- `mk(id, options)` — ApexCharts factory; merges `options` with theme defaults
  (`#text` colors, grid, tooltip, animation respect for reduced-motion).
- `esc(str)` — sanitizer (`textContent` round-trip) used everywhere user data hits
  innerHTML. **Always use it for any Excel-derived string injected into HTML.**

---

## 8. Formatting & i18n

- Currency is **NOK** (Norwegian Krone) at the project level. The Quote workbook stores
  base values in `Sum Total Base Currency` (NOK); raw `Sum Total` may be in USD.
  Display helpers: `fmt`, `fmtCur`, `fmtPct`, `fmtDays`, `fmtInt`. `fmtCur` prefixes
  with `$` — verify per-tab whether labels say "NOK" or "USD" before changing this.
- Dates are normalized via `parseDate()` / `excelDate()` which handle:
  - Excel serial numbers (xlsx returns `Date` when `cellDates:true`)
  - ISO strings
  - `MM/DD/YYYY` / `M/D/YYYY` US format
- All UI copy is English. Comments may be Spanish.

---

## 9. Tests

```
package.json scripts:
  test       → npx playwright test
  test:v5    → npx playwright test tests/dashboard_v5_implementation.spec.js
  test:ui    → npx playwright test --ui
  test:headed
  test:report
```

`tests/dashboard_v5_implementation.spec.js` is the v5-specific suite (currently the
file with WIP changes per `git status`). `tests/dashboard.spec.js` covers v3 and is
kept for regression diffing.

`playwright.config.js` lives at repo root.

---

## 10. Known constraints & gotchas

- **Single file is the contract** — do not split into modules without coordinating
  with the user. The artifact is consumed standalone (sometimes mailed, sometimes
  hosted on Azure Static Web Apps via `axess-dashboard-app/`).
- **Header names are the schema.** Any rename in the Excel templates breaks ingestion.
  Verify with the literal headers in §6 before touching parsers.
- **Master sheet has merged headers.** Don't trust `SheetNames[0]` blindly — always
  go through `processMaster`'s scan-for-header-row logic.
- **Auto-cross-load**: uploading the Personnel template also fills Equipment, and
  vice-versa, when the same workbook contains both sheets. Toasts the user when it
  happens.
- **Calibration semaphore depends on `Calibration due date` from sheet *Lists***,
  not from *Equipment planner*. Calibration data is keyed by `Equipment type`
  string (case-sensitive trim).
- **XSS surface**: every Excel value injected into innerHTML must go through
  `esc()`. The legacy React app (`axess-dashboard-app/`) had a documented innerHTML
  XSS issue in `GanttChart.tsx` — do not reintroduce that pattern in v5.
- **Currency labelling**: `fmtCur` always emits `$`. If a future tab needs explicit
  `NOK`/`USD` segregation, add a new helper rather than mutating `fmtCur` (callers
  rely on the `$` prefix in chart tooltips).
- **Charts global `charts = {}`**: chart instances are stored here, not destroyed
  between renders. When changing render code, ensure ApexCharts is updated via
  `.updateOptions` / `.updateSeries` if reusing the slot, or `.destroy()` before
  re-`mk`'ing the same id.
- **Demo seed** runs on first paint — never assume `state.*.raw === []` means
  "no data". After any upload, the seed is replaced.
- **License system (per-client build)** — top of the `<script>` block defines
  a `LICENSE = { client, expiresAt, warnDaysBefore, contact, renewalUrl }`
  object. `checkLicense()` runs first in `DOMContentLoaded` (before
  `generateDemoData()` / `renderTab` calls). Three states:
  - **Valid** → renders a brand-colored badge in the topbar subtitle
    ("◆ Licensed to {client} · valid until YYYY-MM-DD"). No banner.
  - **Within `warnDaysBefore`** (default 14) → amber badge + sticky amber
    `.license-banner` above the topbar with renewal CTA. Dashboard still
    fully usable.
  - **Past expiry** (`daysLeft < 0`) → red badge, full-viewport
    `.license-block` modal with renewal contact info, **renders are skipped**
    (no demo seed, no tab renders). Main is blurred + `pointer-events:none`.
  The check uses local-time component parsing of `expiresAt` to avoid the
  UTC-shift trap (`new Date('YYYY-MM-DD')` is parsed as UTC midnight and can
  land on the previous calendar day in negative-offset locales). Per-client
  deliveries: update the `LICENSE` object before sending the HTML. This is a
  soft deterrent for non-technical clients; a savvy developer can patch the
  check via DevTools — pair with obfuscation / hosted deploy if stronger
  protection is needed.
- **Master QA compliance is now driven by the 000-900 columns**, not by
  `QA Status` (Comment) or the legacy `KOM/COM/Timesheets/...` flags. Source of
  truth: `MASTER_QA_TARGET_COLS = ['000'..'900']`, `normalizeQAItemStatus()`,
  `getMasterWOQA()`, `computeMasterQAComplianceRate()`. The KPI "QA Compliance"
  in the top KPI row and the radial/card in the Overview both consume
  `computeMasterQAComplianceRate(d)` — denominator excludes WOs with zero loaded
  data (all-NA OR all-blank). Per-cell color map in `QA_STATE_COLORS` (6 states:
  Completed=green, Under preparation=yellow, Not completed=red, Scope ongoing=blue,
  Scope planned=purple, Not applicable=black). Per-WO color (green/amber/red/na)
  is derived in `getMasterWOQA().color` for the Overview breakdown.
- **Pipeline kanban hover shows technicians**: `masterKanbanCardHtml(r, techByWO)`
  receives a `wo → [{name,competency}]` index built by `buildPersonnelWOIndex()`
  from `state.personnel.raw`. The cross-tab match keys on `Work Order Number`
  (master) vs `Work Order` (personnel), lowercased + trimmed. The tooltip uses
  the native `title` attribute so it escapes the kanban scroll container's
  `overflow:auto` without z-index tricks — keep it that way unless you want to
  reposition with JS.
- **Master From/To filter applies to the whole tab**, not just Timeline. The
  predicate is interval-overlap on `[Start date, End date]`, identical to
  Equipment. WOs without dates are excluded as soon as either bound is set.
  Do not confuse with `m-ops-zero` (Timeline reference line only).
- **Upload split is intentional**: 3 pills (Operations / Quote Log / Leads),
  not one. The Operations pill loads `Master Projects` + `Planner` +
  `Equipment planner` (+ `Lists` for calibration). Even if the user uploads
  an all-in-one workbook that also contains Quote / Leads sheets, the
  Operations pill **does not** load them — Quote and Leads each have their
  own pill so the client can refresh them independently. Sheet-name heuristics
  live in `findQuoteSheet / findMasterSheet / findLeadsSheet` and inline
  checks for Planner / Equipment planner. If you rename a sheet in the
  Operations workbook, update these helpers; otherwise the parser will
  silently fall back to `SheetNames[0]` (likely loading the wrong dataset).

---

## 11. Working on V5

Quick paths:

```
Layout / sidebar / topbar:        lines 391–489
Tab markup:                       lines 494–642
Globals + state + utils:          lines 653–845
Upload pipeline + parsers:        lines 1090–1303
Tab renderers:                    lines 1587 (quote), 2282 (personnel),
                                  3403 (equipment), 4276 (master), 4583 (leads)
```

Conventions in this file:

- Section banners `/* ═══ FOO ═══ */` separate concerns. Add new sections under an
  existing banner rather than introducing a new top-level region.
- New tabs require: a sidebar nav-item with `data-tab=...`, a mobile-nav button,
  an upload pill, a `<div.tab-panel id="panel-...">`, an entry in the
  `titles` map of `switchTab`, a `state.<tab>` slot, a `process<Tab>` parser, a
  `render<Tab>` function, and a `case` in `renderTabContent`.
- Filters use `applyFilters(type)` (does the actual filtering on `state[type].raw
  → filtered`) and `resetFilters(type)` (UI + state). Year filter has a special
  helper `onYearFilter(type)` that also resets From/To.

Recent git history (last 5):
```
f6874ae  Win Rate fix (denominator = total quotes in filtered view)
54b82ab  Rename monolithic dashboard → v4 for traceability
c2c9c22  Fix data label colors in Leads by Responsible on theme switch
89df3f2  Leads Log: Year filter, new charts, scope drill-down, visual polish
eae2ae4  Drill-down on Revenue vs Cost over Time chart
```

---

## 12. Companion artifacts in `/templates`

| File | Purpose |
|----|----|
| **`Axess_Unified_Workbook.xlsx`** | **Canonical single source** — 9 sheets: *Planner*, *Equipment planner*, *Lists*, *Examples*, *README*, *Master Projects*, *Master Validation*, *Leads*, *Quote Log*. Uploading via any pill auto-loads all 5 datasets. |
| `Leads 2.xlsx` | Legacy standalone Leads export (Power Query feed) — schema reference for §6.5 |
| `Master project sheet.xlsx` / `Project master sheet.xlsx` | Legacy Master Project workbook — schema reference for §6.4 |
| `Personnel_Planner_TEMPLATE.xlsx`, `Personnel and equipment Planner.xlsx` | Legacy Personnel/Equipment templates with *Planner*, *Equipment planner*, *Lists*, *Examples*, *README* sheets |
| `QuoteLog_2026-03-16_210018.xlsx` | Legacy snapshot of Quote Log export — schema reference for §6.1 |
| `budget_forecast_2025.json` | Static reference data (not yet wired to v5) |
| `Axess Profile Manual (Full).pdf` | Brand guidelines (colors, fonts) — already encoded in CSS tokens |
| `imagen (1).jpeg`, `9723582.jpg`, `9723568.psd` | Brand assets |

If a template is updated, **diff its first-row headers against §6 before merging**.
