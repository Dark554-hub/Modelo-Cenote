# Design System

## Palette
We use a high-contrast, scientific "tech-organic" theme. The default warm cream/sand background is replaced with a crisp, professional slate off-white/light gray.

- **Background**: `oklch(98.5% 0.003 240)` — A clean, cold, professional off-white/slate light background.
- **Surface**: `oklch(100% 0 0)` — Pure white panels for selective structural alignment.
- **Ink (Primary Text)**: `oklch(15% 0.01 240)` — Deep slate black for absolute reading comfort and contrast.
- **Muted Ink (Secondary Text)**: `oklch(45% 0.01 240)` — Soft slate gray.
- **Accent (Primary)**: `oklch(60% 0.15 240)` — Tech cobalt blue for active states, data sync, and highlights.
- **Status Green (NOM compliant)**: `oklch(50% 0.12 145)` — Forest Green.
- **Status Yellow (Warning)**: `oklch(75% 0.15 80)` — Amber Gold.
- **Status Red (Alert)**: `oklch(45% 0.16 25)` — Crimson Red.

## Typography
A highly legible sans-serif paired with a structured monospace for tabular data. Emojis and serif italics are avoided to maintain scientific precision.

- **Primary Sans**: `Plus Jakarta Sans`, system-ui, sans-serif
- **Data Mono**: `JetBrains Mono`, monospace
- **Scale**: Bold typography weight contrasts, text-wrap: balance on headers, text-wrap: pretty on descriptions.

## Spatial System & Layout
- **No Card Clutter**: Elements flow naturally using logical division (dividers, spacing, typography) rather than enclosing every single block in rounded cards.
- **Borders**: 1px thin dividers (`border-slate-100` / `border-slate-200`) rather than thick accent borders.
- **Spacing**: 4px grid base. 16px (4), 24px (6), 32px (8), 48px (12).

## Components
- **Dashboard Header**: Precise navigation, dynamic connection status.
- **Metrics Table**: Compact, readable monospace rows with color-coded status badges.
- **ML Diagnostics**: Clean block with structured recommendations and custom SVGs.
