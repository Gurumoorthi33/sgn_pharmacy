# SGN Token System — Technical Documentation

**Project:** SGN Token System (Pharmacy Token Queue Management)
**Hospital:** Trichy SRM Medical College Hospital and Research Centre
**Version:** 0.1.0
**Date:** September 2026

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [End-to-End System Architecture](#2-end-to-end-system-architecture)
3. [Technology Stack](#3-technology-stack)
4. [Repository Folder Structure](#4-repository-folder-structure)
5. [File-by-File Functional Description](#5-file-by-file-functional-description)
6. [Database Design (Supabase / PostgreSQL)](#6-database-design-supabase--postgresql)
7. [Core Business Logic — The Token Lifecycle](#7-core-business-logic--the-token-lifecycle)
8. [Frontend Layer](#8-frontend-layer)
9. [Backend Layer](#9-backend-layer)
10. [Authentication & Role-Based Access](#10-authentication--role-based-access)
11. [The Printing Pipeline](#11-the-printing-pipeline)
12. [Kotlin Application Integration (SGN Print Bridge)](#12-kotlin-application-integration-sgn-print-bridge)
13. [Reports & Daily Auto-Reset](#13-reports--daily-auto-reset)
14. [Deployment](#14-deployment)
15. [Configuration Reference](#15-configuration-reference)
16. [Security Considerations](#16-security-considerations)

---

## 1. Project Overview

The SGN Token System is a **web-based, multi-counter token queue management application** built for the outpatient **pharmacy of Trichy SRM Medical College Hospital and Research Centre**. It replaces the manual, paper-based queue with a digital, real-time system that:

- **Issues** printed thermal tokens to patients at the Dispensing Station.
- Routes every patient through three service stages in a strict **FIFO (First-In-First-Out)** order:
  1. **Entry Counter** (registration) — 4 parallel counters.
  2. **Payment Counter** (bill payment) — 1 counter.
  3. **Dispatch Counter** (medicine handover) — 1 counter.
- Displays the **currently called token numbers on a large public Display Board** with **Tamil voice announcements**.
- Provides an **Admin Dashboard** with live statistics, downloadable CSV reports, and emailed daily summaries.
- **Automatically resets** the board every day at **11:40 PM IST**, archiving the day's totals into a summary table and emailing a report to pharmacy supervisors.

The system is a **cloud-based Progressive Web Application (PWA)** served on **Vercel** with a **Supabase (PostgreSQL)** backend-as-a-service, communicating over **HTTPS REST + WebSocket real-time pub/sub**. It also integrates with local edge hardware — a **Zebra ZD230 thermal label printer** — through a local **Python FastAPI "print bridge"**, and on the Sunmi T2s Lite Android tablet through a **native Kotlin foreground service (SGN Print Bridge)** that owns the USB printer.

---

## 2. End-to-End System Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                          CLOUD HOSTING (Vercel — Next.js App Router)                          │
│                                                                                              │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌───────────────┐  │
│  │  /dispensing│   │   /entry    │   │  /payment   │   │  /dispatch  │   │   /admin      │  │
│  │  (Generate )│   │ (4 counters)│   │ (1 counter) │   │ (1 counter) │   │ (dashboard &  │  │
│  │  & Print)   │   │             │   │             │   │             │   │  reports)     │  │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘   └──────┬──────┘   └───────┬───────┘  │
│         │ Server Actions  │ Server Actions  │ Server Actions  │ Server Actions  │ Server Act.│
│         └────────┬────────┘        │        └───────┬─────────┘        │         └────┬─────┘ │
│                  ▼                ▼                  ▼                 ▼               ▼       │
│        ┌──────────────────────────────────────────────────────────────────────────────┐      │
│        │          Next.js Middleware + API Route + Supabase SSR Clients               │      │
│        │          (auth guard, /api/cron/daily-reset, lib/supabase/*)                 │      │
│        └───────────────────────────────────────┬──────────────────────────────────────┘      │
└───────────────────────────────────────────────┼──────────────────────────────────────────────┘
                                                 │  HTTPS REST (Supabase SDK) + Realtime WebSocket
                                                 ▼
                        ┌─────────────────────────────────────────────────────┐
                        │              SUPABASE (PostgreSQL)                  │
                        │  Tables: auth.users, profiles, tokens,              │
                        │          daily_summaries                             │
                        │  Stored procedures (RPC): generate_token,           │
                        │          call_next_entry, complete_entry, ...        │
                        │  Realtime: postgres_changes on "tokens"             │
                        └─────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                  PUBLIC DISPLAY BOARD                                        │
│          Browser (Fire TV / kiosk / tablet) opens /display (no login required)               │
│          • Supabase Realtime subscription → live "Now Serving" tiles (5 counters)             │
│          • Web Speech API (speechSynthesis) → Tamil voice announcements                       │
│          • Web Audio API → chime before each announcement                                    │
│          • Auto language toggle EN ⇄ தமிழ் every 7 seconds                                   │
└──────────────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                        LOCAL PRINT INFRASTRUCTURE (edge hardware)                            │
│                                                                                              │
│  Case A — Windows PC beside the ZD230:                                                       │
│    Browser ──POST /api/print/zpl/──► printer-bridge/app.py (FastAPI, port 5000)              │
│            localhost       └──► win32print queue (ZDesigner ZD230-203dpi ZPL) ──► ZD230      │
│                                                                                              │
│  Case B — Sunmi T2s Lite / Android tablet (Termux):                                          │
│    Browser ──POST /api/print/zpl/──► printer-bridge/app.py ──► "SGN Print Bridge" Kotlin app  │
│                                 (detects android)       HTTP 127.0.0.1:6001 (raw ZPL body)  │
│                                                                   └──► Zebra Link-OS SDK ─► ZD230 (USB)
│                                                                                              │
│  Case C — Networked ZD230 (PRINTER_IP set):                                                   │
│    printer-bridge/app.py ──► TCP raw socket :9100 ──► ZD230  (used on ANY platform)          │
│                                                                                              │
│  Fallback — no bridge configured:  hidden print iframe (50×25 mm @page) ──► browser dialog    │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### How the layers talk to each other

| From → To | Protocol | Purpose |
|---|---|---|
| Browser (React) → Supabase | HTTPS REST (supabase-js) | Session refresh, RPC calls (`generate_token`, `call_next_entry`, …), queries |
| Supabase → Browser | WebSocket (Realtime `postgres_changes`) | Live push of every token change to stations and the display board |
| Browser → Next.js Server | Server Actions (POST) | Role-guarded server-side calls that proxy to Supabase RPC |
| Next.js Server → Supabase | Supabase SSR / Service-Role client | Auth checks, admin RPCs, cron reset |
| Vercel Cron → Next.js API | HTTPS GET + `Authorization: Bearer` | Daily 11:40 PM reset & report email |
| Dispensing Browser → Print Bridge | HTTP POST (JSON) | Silent ZPL label printing |
| Python Print Bridge → Kotlin App | HTTP POST (raw ZPL bytes) | Android USB printing via Zebra SDK |
| Python Print Bridge → ZD230 | TCP 9100 / win32print / CUPS | Raw ZPL to printer |
| Next.js Server → SMTP | Nodemailer (STARTTLS/SSL) | Daily report email with CSV attachment |

---

## 3. Technology Stack

### Frontend
| Technology | Version | Role |
|---|---|---|
| Next.js (App Router) | 16.3.0 | React meta-framework — Server Components + Client Components + Server Actions + Route Handlers |
| React | 19.2.4 | UI library |
| TypeScript | 5.7.3 | Static typing across the codebase |
| Tailwind CSS | 4.3.3 | Utility-first styling |
| shadcn/ui (base-nova) + Base UI | 4.8.x / 1.5.0 | Pre-built accessible UI primitives (`/components/ui/*`) |
| lucide-react | 1.16.0 | Icon set |
| JsBarcode | 3.12.3 | Barcode generation (dependency available) |
| next/font | — | Inter, JetBrains Mono, Noto Sans Tamil |
| @vercel/analytics | 1.6.1 | Web analytics (loaded in production only) |

### Backend & Data
| Technology | Version | Role |
|---|---|---|
| Next.js Server Actions / Route Handlers | 16.3.0 | Server-side business logic |
| Supabase (supabase-js + @supabase/ssr) | 2.110.8 / 0.12.3 | Auth, PostgreSQL database, RPC stored procedures, Realtime pub/sub |
| Nodemailer | 9.0.3 | SMTP daily report email |
| Vercel Cron | — | Scheduled daily reset endpoint |

### Local Print Infrastructure
| Technology | Version | Role |
|---|---|---|
| Python + FastAPI | py3.12 / fastapi<0.100 | Local ZPL print bridge (`printer-bridge/app.py`) |
| pywin32 / CUPS / pyusb | — | Platform-specific ZPL transports |
| Zebra ZD230 | 203 dpi | Thermal label printer (2″ roll, 50×25 mm labels) |
| **Kotlin / Android (native, separate repo)** | — | "SGN Print Bridge" foreground service — owns the ZD230 over USB using **Zebra Link-OS SDK**, exposes local HTTP `127.0.0.1:6001` |

---

## 4. Repository Folder Structure

```
sgn-pharmacy-token-system/
├── app/                          # Next.js App Router — routes (UI + server logic)
│   ├── api/
│   │   └── cron/
│   │       └── daily-reset/
│   │           └── route.ts      # Vercel Cron endpoint (daily 11:40 PM IST reset)
│   ├── admin/
│   │   ├── actions.ts            # Server Actions: stats, CSV download, email
│   │   └── page.tsx              # Admin Dashboard page
│   ├── auth/
│   │   ├── actions.ts            # Server Actions: login, sign out
│   │   ├── callback/
│   │   │   └── route.ts          # OAuth/email-confirmation code exchange
│   │   ├── error/
│   │   │   └── page.tsx          # Auth error screen
│   │   └── login/
│   │       └── page.tsx          # Staff sign-in screen
│   ├── dispatch/
│   │   ├── actions.ts            # Dispatch counter Server Actions
│   │   └── page.tsx              # Dispatch counter page
│   ├── dispensing/
│   │   ├── actions.ts            # Token generation Server Action
│   │   └── page.tsx              # Dispensing (token issue) page
│   ├── display/
│   │   └── page.tsx              # Public Display Board page (no auth)
│   ├── entry/
│   │   ├── actions.ts            # Entry counter Server Actions
│   │   └── page.tsx              # Entry counter page
│   ├── payment/
│   │   ├── actions.ts            # Payment counter Server Actions
│   │   └── page.tsx              # Payment counter page
│   ├── globals.css               # Global styles + Tailwind v4 theme tokens
│   ├── layout.tsx                # Root layout (fonts, metadata, analytics)
│   └── page.tsx                  # Home: role-based redirect
│
├── components/                   # React components (mostly "use client")
│   ├── admin/
│   │   └── admin-dashboard.tsx   # Live dashboard, stats, CSV/email buttons
│   ├── auth/
│   │   ├── auth-shell.tsx        # Auth screen shell (logo + card)
│   │   └── login-form.tsx        # Username/password form (useActionState)
│   ├── dispatch/
│   │   └── dispatch-board.tsx    # Dispatch station UI
│   ├── dispensing/
│   │   ├── dispensing-panel.tsx  # Generate & Print panel
│   │   └── token-label.tsx       # Static token label component
│   ├── display/
│   │   └── display-board.tsx     # Public board: tiles, clock, TTS queue
│   ├── entry/
│   │   ├── entry-board.tsx       # Entry station UI
│   │   └── entry-counter-card.tsx# Per-counter card (Call/Complete/Hold)
│   ├── payment/
│   │   └── payment-board.tsx     # Payment station UI
│   ├── ui/                       # shadcn/ui primitives (button, card, input, …)
│   ├── counter-station.tsx       # Reusable single-counter station (payment/dispatch)
│   └── station-header.tsx        # Top bar with logo, title, user, display link
│
├── hooks/
│   └── use-tokens.ts             # Shared live-tokens React hook (Realtime + poll)
│
├── lib/                          # Shared libraries
│   ├── supabase/
│   │   ├── client.ts             # Browser Supabase client
│   │   ├── proxy.ts              # Middleware session refresh
│   │   └── server.ts             # SSR client + admin (service-role) client
│   ├── get-session.ts            # requireRole() route guard helper
│   ├── print-bridge.ts           # Client-side printing (bridge + iframe fallback)
│   ├── report.ts                 # Server-side stats, CSV builder, emailer
│   ├── types.ts                  # Domain types + constants (roles, statuses, etc.)
│   └── utils.ts                  # cn() className merge helper
│
├── printer-bridge/               # LOCAL Python printing service (not deployed)
│   ├── app.py                    # FastAPI print bridge — platform auto-detect + ZPL
│   ├── mock_printer.py           # Mock ZD230 (TCP 9100) for offline testing
│   ├── send_test.py              # Standalone termux-usb USB print worker
│   ├── test_platform.py          # Unit tests for app.py (test runner included)
│   ├── test_e2e.sh               # End-to-end print script
│   ├── test_token_batch.sh       # Batch token print test
│   ├── requirements.txt          # Python deps (Linux/Android)
│   ├── requirements-windows.txt  # Python deps (Windows)
│   ├── sgn-prints/               # Captured ZPL/PNG files (from mock/testing)
│   ├── uploads/                  # Scratch dir for legacy image path
│   └── .venv/                    # Local Python virtual environment
│
├── scripts/
│   └── requirements.txt          # Legacy utility deps (jsBarcode preview etc.)
│
├── sgn-prints/
│   └── print.png                 # Legacy print preview image
│
├── public/
│   └── sgn-logo.png              # Hospital/Pharmacy logo
│
├── .env / .env.example           # Environment configuration (secrets NOT committed)
├── components.json               # shadcn/ui configuration
├── eslint.config.mjs             # ESLint flat config
├── middleware.ts                 # Next.js middleware (Supabase session refresh)
├── next.config.mjs               # Next.js config
├── package.json                  # npm dependencies & scripts
├── postcss.config.mjs            # PostCSS (Tailwind v4 plugin)
├── tsconfig.json                 # TypeScript configuration
├── vercel.json                   # Vercel Cron schedule
└── TTS_REVERT_SUMMARY.md         # Dev note: MP3 → browser TTS migration summary
```

---

## 5. File-by-File Functional Description

### 5.1 `app/` — Routes & Server Logic

#### `app/layout.tsx`
Root layout. Loads the Inter, JetBrains Mono and **Noto Sans Tamil** web fonts (Tamil font supports the bilingual display board), sets metadata and icons, and injects **@vercel/analytics** in production.

#### `app/page.tsx`
Home page (route `/`). Fetches the current session server-side, looks up the user's role in the `profiles` table and **redirects to the correct station home** using `ROLE_HOME` (e.g. entry staff → `/entry`, dispensing → `/dispensing`). Unauthenticated users go to `/auth/login`.

#### `app/globals.css`
Global stylesheet: Tailwind v4 import, CSS custom properties for the shadcn theme (background, foreground, primary, success, warning, destructive, etc.), and component styles such as the `token-label` print styles.

#### `app/api/cron/daily-reset/route.ts`
**Vercel Cron endpoint** (guarded by `Authorization: Bearer CRON_SECRET`). Called every day at **18:10 UTC = 11:40 PM IST** (see `vercel.json`). It:
1. Calls the `reset_day()` Postgres RPC — archives today's totals into `daily_summaries` and deletes today's `tokens`.
2. Emails the daily CSV report via `emailDailyReport()`.
3. Returns `{ ok, date, emailed, stats }`.

#### `app/dispensing/actions.ts`
One Server Action — `generateTokenAction()`. Authenticates the user and calls the Postgres RPC **`generate_token()`**, which inserts a new token for today with status `pending_entry` and returns the created `Token` row. This is the only place tokens are created.

`app/dispensing/page.tsx` renders the Dispensing page: it `requireRole("dispensing")`, counts today's tokens, and mounts `<DispensingPanel initialCount>`.

#### `app/entry/actions.ts`
Entry counter Server Actions (each calls the matching Postgres RPC after an auth check):
- `callNextEntryAction(counter)` → `call_next_entry(p_counter)` — brings the next FIFO token to this counter (`entry_serving`).
- `completeEntryAction(id)` → `complete_entry(p_id)` — finishes entry service (`entry_completed_at`, moves token → `pending_payment`).
- `waitAndNextEntryAction(id, counter)` → `wait_and_next_entry(p_id, p_counter)` — parks the current token (`entry_waiting`) and immediately calls the next one.
- `callEntryTokenAction(id, counter)` → `call_entry_token(p_id, p_counter)` — recalls a specific held token to this counter.
- `recallEntryAction(id)` → `recall_entry(p_id)` — re-announces the serving token (updates `entry_recalled_at`, does **not** advance the queue).

`app/entry/page.tsx` uses `requireRole("entry")`, binds the logged-in user to their fixed counter (`profiles.counter` = 1, 2 or 3) and renders `<EntryBoard counter />`.

#### `app/payment/actions.ts`
Payment counter actions (same pattern as entry, no counter argument since there is a single payment counter):
- `callNextPaymentAction()` → `call_next_payment()`
- `completePaymentAction(id)` → `complete_payment(p_id)`
- `waitAndNextPaymentAction(id)` → `wait_and_next_payment(p_id)`
- `callPaymentTokenAction(id)` → `call_payment_token(p_id)`
- `recallPaymentAction(id)` → `recall_payment(p_id)`

`app/payment/page.tsx` → `requireRole("payment")` + `<PaymentBoard />`.

#### `app/dispatch/actions.ts`
Dispatch counter actions. **Dispatch uses manual token selection** rather than auto FIFO because staff pick the next caller from the ready list:
- `callDispatchAction(id)` → `call_dispatch(p_id)` — move a specific token to dispatch.
- `completeDispatchAction(id)` → `complete_dispatch(p_id)` — mark `completed`.
- `skipDispatchAction(id)` → `skip_dispatch(p_id)` — patient absent → park token at the back of the dispatch queue (`dispatch_requeued_at`).
- `recallDispatchAction(id)` → `recall_dispatch(p_id)` — re-announce.

`app/dispatch/page.tsx` → `requireRole("dispatch")` + `<DispatchBoard />`.

#### `app/admin/actions.ts`
Admin-only Server Actions (each verifies the caller's `profiles.role === "admin"`):
- `getStatsAction()` → `admin_stats()` RPC → live aggregated stats.
- `downloadReportAction()` → builds today's CSV text for client-side download.
- `emailReportNowAction()` → emails today's report immediately via `emailDailyReport()`.

`app/admin/page.tsx` → `requireRole("admin")` + `<AdminDashboard />`.

#### `app/display/page.tsx`
Public display board page. Marked `force-dynamic`. **No authentication** — it is intentionally public so the wall-mounted TV/kiosk can show it without a login.

#### `app/auth/actions.ts`
- `loginAction(prev, formData)` — **username → synthetic email** (`username@sgn.local`, see `lib/types.ts`), then `supabase.auth.signInWithPassword`. Reads the user's role and `redirect` to their station home.
- `signOutAction()` — `supabase.auth.signOut()` then redirect to `/auth/login`.

#### `app/auth/callback/route.ts`
Route handler that exchanges the Supabase auth `code` for a session (`exchangeCodeForSession`) after an OAuth/confirmation redirect and sends the user to `next`.

#### `app/auth/login/page.tsx` and `app/auth/error/page.tsx`
Login screen (username/password + link to the public display board) and a friendly auth error screen respectively.

### 5.2 `components/` — React UI

| File | Purpose |
|---|---|
| `admin/admin-dashboard.tsx` | Live dashboard: totals, 4 stat cards, entry-counter performance bars, daily summary, **Download CSV** and **Email report** buttons. Uses `useTokens()` for live counts. |
| `auth/auth-shell.tsx` | Shared shell for the login/error screens — logo, hospital name, card. |
| `auth/login-form.tsx` | Username/password form bound to `loginAction` via `useActionState`. |
| `counter-station.tsx` | Reusable single-counter station (originally for Payment/Dispatch): "Now serving" + waiting FIFO queue + Call/Complete buttons. |
| `dispatch/dispatch-board.tsx` | Dispatch UI: big "Now serving" number, **Complete & hand over**, **Call again**, **Wait & proceed** buttons, plus a tapped "Ready for dispatch" list (manual call). |
| `dispensing/dispensing-panel.tsx` | The **Generate & Print** panel: huge live "tokens issued today" counter, one big button that calls `generateTokenAction()` then prints 2 labels. Handles print-bridge errors with a graceful browser-print fallback. |
| `dispensing/token-label.tsx` | Static 50×25 mm label markup (hospital name, TOKEN caption, big number). |
| `display/display-board.tsx` | The public board (see §8): 6 live counter tiles, bilingual flip, clock, "Enable announcements" button, Web Audio chime, SpeechSynthesis Tamil queue, 8 change watchers to trigger announcements. |
| `entry/entry-board.tsx` | Entry station: own-counter card + held-tokens card + FIFO waiting queue + other counters' live status. |
| `entry/entry-counter-card.tsx` | Per-counter controls: **Call next**, **Complete**, **Call again**, **Wait & continue**. |
| `payment/payment-board.tsx` | Payment station: same layout pattern as entry, single counter, plus held-token recall and FIFO by `entry_completed_at`. |
| `station-header.tsx` | Header bar for staff pages — logo, hospital/system name, station title, signed-in user, and a "Display Board" link. |
| `ui/*` (`badge`, `button`, `card`, `input`, `label`, `select`) | shadcn/ui primitives built on Base UI + Tailwind. |

### 5.3 `hooks/` 
#### `hooks/use-tokens.ts`
Shared client hook used by every station board. Subscribes to **Supabase Realtime `postgres_changes` on the `tokens` table** and maintains a live, sorted list of **today's** tokens (IST date). Also runs a **5-second polling fallback** so screens stay in sync even if a realtime event is missed.

### 5.4 `lib/` — Shared Libraries

| File | Purpose |
|---|---|
| `lib/supabase/client.ts` | `createBrowserClient` using `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`. |
| `lib/supabase/server.ts` | `createClient()` SSR client (reads cookies) for server components/actions; **`createAdminClient()`** using `SUPABASE_SERVICE_ROLE_KEY` — used to create pre-confirmed staff accounts and call admin RPCs server-side. |
| `lib/supabase/proxy.ts` | `updateSession()` — runs inside Next.js middleware; refreshes the Supabase session cookies on every request and guards protected routes (public: `/`, `/auth*`, `/display`). |
| `lib/get-session.ts` | `requireRole(expected)` — page-level guard. Verifies the logged-in user's role from `profiles` and redirects to their own station home if they hit the wrong one. |
| `lib/print-bridge.ts` | Client-side printing. `sendToPrintBridge()` POSTs `{hospital, token_number, copies}` to the local bridge; `printLabelsViaIframe()` is the fallback that renders the label(s) in a hidden isolated iframe with a 50×25 mm `@page` so the printer prints exactly one label per page. |
| `lib/report.ts` | Server-only (imports `server-only`). `todayIST()`, `buildCsv()`, `fetchDayStats()` (via `admin_stats` RPC), `emailDailyReport()` (Nodemailer + SMTP, HTML body + CSV attachment). |
| `lib/types.ts` | Domain model: `TokenStatus` union, `Token`, `Role`, `ROLE_HOME`, `ROLE_LABELS`, `usernameToEmail()`, `DISPATCH_RESET_TIME`, `REPORT_RECIPIENTS`, hospital/system name constants. |
| `lib/utils.ts` | `cn()` — `clsx` + `tailwind-merge` for conditional classes. |

### 5.5 Root configuration files

| File | Purpose |
|---|---|
| `middleware.ts` | Runs `updateSession()` on every navigation (excludes static assets). Configures the matcher. |
| `next.config.mjs` | Ignores TS errors at build (project in active iteration) + unoptimized images. |
| `vercel.json` | Declares the Cron job `10 18 * * *` hitting `/api/cron/daily-reset`. |
| `tsconfig.json` | TypeScript config with `@/*` path alias. |
| `components.json` | shadcn/ui config (style `base-nova`, Tailwind v4, lucide icons). |
| `package.json` | Scripts (`dev`, `build`, `start`, `lint`) and all dependencies. |
| `eslint.config.mjs`, `postcss.config.mjs` | ESLint flat config and PostCSS/Tailwind v4 plugin setup. |

### 5.6 `printer-bridge/` — Local Python Print Service

| File | Purpose |
|---|---|
| `app.py` | **FastAPI print bridge**, run on the PC/tablet physically connected to the ZD230. Auto-detects the platform (Windows / Android-Termux / Linux) and picks a send path (TCP 9100, win32print, CUPS, or the Kotlin HTTP service). Endpoints: `POST /api/print/zpl/` (JSON or raw ZPL), `GET /api/print/diagnostics`, `GET /health`, legacy `POST /api/print/`. Includes exact ZPL generation with font-metric based layout (`FONT_A_ADVANCE`, word wrap) sized from the physical 50×25 mm label. |
| `mock_printer.py` | A fake ZD230 listening on TCP 9100 that captures every raw ZPL payload to `sgn-prints/zpl_*.txt` and can render a PNG preview via Labelary — used to develop the label design without hardware. |
| `send_test.py` | Standalone **termux-usb** print worker for Android/Termux (older USB path): wraps a granted USB FD, enumerates interfaces, claims the printer interface and bulk-writes ZPL. |
| `test_platform.py` | Unit-style test harness for `app.py` covering platform detection, backend selection, Android path behaviour, diagnostics and readiness. |
| `test_e2e.sh`, `test_token_batch.sh` | Shell scripts that exercise end-to-end and batch printing against the bridge. |
| `requirements.txt`, `requirements-windows.txt` | Python dependencies for Linux/Android and Windows respectively. |

---

## 6. Database Design (Supabase / PostgreSQL)

The schema lives on the **Supabase Postgres** side (managed via the Supabase console/SQL); the web app only ever reads/writes through the typed Supabase client or stored **RPC functions**.

### 6.1 Tables

**`auth.users`** (managed by Supabase Auth)
- Standard Supabase auth table. Staff accounts are created by admin with the service-role client (pre-confirmed, no email verification).

**`profiles`** — one row per staff member, linked to `auth.users.id`
| Column | Type | Description |
|---|---|---|
| `id` | UUID (FK → `auth.users.id`) | Primary key |
| `username` | text | Login name (e.g. `e1`, `p1`, `d1`, `disp1`, `adminsrm`) |
| `full_name` | text | Display name shown in the header |
| `role` | text | `dispensing` \| `entry` \| `payment` \| `dispatch` \| `display` \| `admin` |
| `counter` | int/null | Entry counter number (1, 2 or 3) for entry staff |

**`tokens`** — every token issued each day
| Column | Type | Description |
|---|---|---|
| `id` | UUID | Primary key |
| `token_number` | int | Sequential number for the day (1, 2, 3, …) |
| `service_date` | date (IST) | The day the token belongs to (`Asia/Kolkata`) |
| `status` | text | See the token lifecycle below |
| `entry_counter` | int/null | Which entry counter served it |
| `created_at` | timestamptz | Issue time |
| `entry_called_at` | timestamptz/null | Last "call" at entry (re-announce updates recall instead) |
| `entry_recalled_at` | timestamptz/null | Manual re-announce trigger |
| `entry_completed_at` | timestamptz/null | Entry finished → token eligible for payment |
| `payment_called_at` | timestamptz/null | Last "call" at payment |
| `payment_recalled_at` | timestamptz/null | Manual re-announce trigger |
| `payment_completed_at` | timestamptz/null | Payment done → token eligible for dispatch |
| `dispatch_called_at` | timestamptz/null | Last "call" at dispatch |
| `dispatch_requeued_at` | timestamptz/null | "Wait & proceed" timestamp → token goes to back of dispatch queue |
| `completed_at` | timestamptz/null | Dispatch completed |

The **realtime** system broadcasts every insert/update/delete on this table so all stations and the display update instantly.

**`daily_summaries`** — archived end-of-day snapshots
| Column | Type | Description |
|---|---|---|
| `service_date` | date | The day |
| `total` | int | Tokens issued |
| `first_token` / `last_token` | int | Range |
| `entry_1 / entry_2 / entry_3 / entry_done` | int | Per-counter entry completion |
| `payment_done` / `dispatch_done` | int | Completed counts |
| `in_progress` | int | Tokens unfinished at reset |
| … | | Timestamps / metadata |

### 6.2 Stored Procedures (RPC functions called by the app)

| RPC | Arguments | Behaviour |
|---|---|---|
| `generate_token()` | — | Inserts the next token for today with status `pending_entry`, returns it |
| `call_next_entry(p_counter)` | counter | Next FIFO `pending_entry` → `entry_serving` for that counter, sets `entry_called_at` |
| `complete_entry(p_id)` | id | `entry_completed_at = now`, status → `pending_payment` |
| `wait_and_next_entry(p_id, p_counter)` | id, counter | Hold current token (`entry_waiting`) + call the next one |
| `call_entry_token(p_id, p_counter)` | id, counter | Recall a held token (only if counter free) |
| `recall_entry(p_id)` | id | Refresh `entry_recalled_at` only (re-announce, no queue movement) |
| `call_next_payment()` | — | Next FIFO `pending_payment` (by `entry_completed_at`) → `payment_serving` |
| `complete_payment(p_id)` | id | `payment_completed_at = now`, status → `pending_dispatch` |
| `wait_and_next_payment(p_id)` | id | Hold + call next |
| `call_payment_token(p_id)` | id | Recall a held token |
| `recall_payment(p_id)` | id | Refresh `payment_recalled_at` only |
| `call_dispatch(p_id)` | id | A specific token → `dispatch_serving` (manual selection) |
| `complete_dispatch(p_id)` | id | Status → `completed`, `completed_at = now` |
| `skip_dispatch(p_id)` | id | Token → back of dispatch queue (`dispatch_requeued_at`) |
| `recall_dispatch(p_id)` | id | Refresh `dispatch_called_at` only |
| `display_board()` | — | Returns the 6 live "Now Serving" rows (station, counter, token_number, called_at, recalled_at) for the display tiles |
| `admin_stats()` | — | Aggregated day stats (reused by the dashboard, CSV and email) |
| `reset_day()` | — | Snapshot totals → `daily_summaries`, delete today's tokens, return stats |

---

## 7. Core Business Logic — The Token Lifecycle

```
  generate_token()
        │
        ▼
   pending_entry ──[call_next_entry]──► entry_serving
        ▲                                  │
        │ (re-call or "Wait & serve next") │ complete_entry
        │                                  ▼
        │                            pending_payment ──[call_next_payment]──► payment_serving
        │                                                                        │
        │                                                          complete_payment│
        │                                                                        ▼
        │                                                            pending_dispatch ──[call_dispatch]──► dispatch_serving
        │                                  (skip_dispatch → back of queue ▲)                              │
        │                                                                              complete_dispatch │
        │                                                                                                    ▼
        └── (held tokens stay entry_waiting / payment_waiting until recalled)                          completed
```

**Status states (from `lib/types.ts`):**
`pending_entry → entry_serving → entry_waiting → pending_payment → payment_serving → payment_waiting → pending_dispatch → dispatch_serving → completed`

### Stage 1 — Dispensing (token issue)
1. The pharmacist presses **"Generate & Print Token"**.
2. `generateTokenAction()` → RPC `generate_token()` inserts today's next sequential number (status `pending_entry`).
3. The web app **prints 2 identical thermal labels** (see §11).
4. Issue count increments. The token is now visible to every entry counter and the display board, in realtime.

### Stage 2 — Entry counters (4 parallel, FIFO)
- Every entry board shows its own counter's state plus the shared FIFO waiting list.
- **Call next** → `call_next_entry(myCounter)` pulls the oldest `pending_entry` into `entry_serving` with that counter; the display board announces "Token எண் N – பதிவு கவுண்டர் C-க்கு வரவும்".
- **Complete** → `complete_entry()`; the token becomes `pending_payment`.
- **Wait & continue** → `wait_and_next_entry()` parks the current token (`entry_waiting`) and immediately calls the next fresh token. Held tokens are listed and can be tapped to recall.
- **Call again** → `recall_entry()` re-announces the same token without advancing the queue.

### Stage 3 — Payment (1 counter, FIFO by entry completion)
Same interaction model as entry but single counter. Tokens enter as `pending_payment` (ordered by `entry_completed_at`), are served (`payment_serving`), can be held/recalled, and on **Complete** move to `pending_dispatch`.

### Stage 4 — Dispatch (1 counter, manual selection)
Staff pick a patient from the "Ready for dispatch" list → `call_dispatch()` announces "Token எண் N – மருந்து வழங்கும் கவுண்டருக்கு வரவும்".
- **Complete & hand over** → `complete_dispatch()` → `completed`.
- **Wait & proceed** → `skip_dispatch()` moves the token to the back of the queue (patient not present).
- **Call again** → re-announces.

### Display board
Constantly reflects `display_board()` — the token currently being served at each of the 5 counters — and voices every new call in Tamil.

---

## 8. Frontend Layer

### Rendering strategy
The app uses **Next.js App Router** with hybrid rendering:
- **Server Components** (pages like `app/entry/page.tsx`) fetch auth + initial data once on the server and stream HTML.
- **Client Components** (`"use client"` boards) manage live UI state and subscribe to realtime updates.
- **Server Actions** (`actions.ts`) give the client full-stack function calls for every mutation — no REST endpoints needed for business logic.

### Real-time data flow
1. `hooks/use-tokens.ts` subscribes to `postgres_changes` on `tokens` (event `*`) via a Supabase Realtime channel (`tokens-realtime`).
2. On every event it re-runs a query of today's tokens ordered by `token_number`.
3. A 5-second `setInterval` polling fallback guarantees eventual consistency even if a WebSocket event is missed.
4. The display board separately calls `display_board()` (an RPC that returns the compact board view), subscribes to the same changes, and polls every 3 seconds.

### The Display Board in detail (`components/display/display-board.tsx`)
- **6 tiles** — Entry Counter 1, 2, 3, 4, Payment, Dispatch — each shows the current token number with colour-coded accents (blue/black/green).
- **Languages** — flips between English and Tamil every 7 seconds.
- **Clock/date** — local time, updated every second.
- **Audio announcements** — after the operator taps **Enable announcements** (a user gesture unlocks audio):
  - A **two-note chime** is played via the Web Audio API.
  - A **Tamil `SpeechSynthesisUtterance`** ("Token எண் N, …") is spoken using a Tamil system voice at rate 0.85.
  - All announcements (dispatch, entry ×3, payment) are serialized in a **global FIFO queue** with per-source **coalescing** (rapid duplicates collapse) and a 12-item safety cap. Manual "Call again" recalls always enqueue.
  - Triggers are **change watchers** on `called_at` / `recalled_at` / `token_number` per counter.

### Styling
Tailwind CSS v4 with shadcn/ui design tokens defined in `app/globals.css`. All staff pages share the `StationHeader` (logo, title, logged-in user, display-board link).

---

## 9. Backend Layer

### Server Actions (the primary backend API)
Every counter action is a **Next.js Server Action** (`"use server"`) that:
1. Re-derives the Supabase user from the request cookies (never trusts the client).
2. Calls the appropriate **Postgres RPC**.
3. Returns a typed result (`{ token? }` / `{ error? }`) so boards can surface errors inline.

### Middleware (`middleware.ts`)
Uses `lib/supabase/proxy.ts` to refresh the Supabase access/refresh session cookies on every request and **redirect unauthenticated users to `/auth/login`** — except on public paths (`/`, `/auth*`, `/display`) and while avoiding redirects on Server-Action POSTs/RSC navigations (which would break flight/action payloads).

### Route-level guards (`lib/get-session.ts`)
`requireRole(role)` reads `profiles.role` and redirects users who hit the wrong station to their own home — e.g. an entry user typing `/admin` is sent back to `/entry`.

### Cron & reporting
- Vercel Cron (`vercel.json`) hits `/api/cron/daily-reset` daily at 18:10 UTC.
- The route authenticates with `CRON_SECRET` (Bearer header), then runs `reset_day()` (snapshot + cleanup) and emails the report via Nodemailer.

---

## 10. Authentication & Role-Based Access

- Users sign in with **username + password**. Usernames are mapped to a **synthetic email** (`username@sgn.local`) because Supabase Auth authenticates by email — this keeps the familiar username login while reusing Supabase Auth untouched (`usernameToEmail()` in `lib/types.ts`).
- Staff accounts are provisioned via the **admin service-role client** (`createAdminClient()`), pre-confirmed so login works immediately.
- Sessions are cookie-based; `@supabase/ssr` persists the access token in an httpOnly cookie and middleware refreshes it transparently.
- The `profiles.role` drives every redirect and authorization decision (`requireRole`, `ROLE_HOME`, admin Server Action checks).

**Roles:** `dispensing` (Generate & Print), `entry` (bound to counter 1–3), `payment`, `dispatch`, `display` (public, no login), `admin` (dashboard/reports).

---

## 11. The Printing Pipeline

The Zebra ZD230 prints **2-up 50×25 mm tokens** after every generation. There are several transport paths, chosen automatically:

```
Browser  ──(1) bridge configured?──►  POST http://localhost:5000/api/print/zpl/
           {hospital, token_number, copies:2}
                                        │
                          printer-bridge/app.py (FastAPI)
                                        │ auto-detects platform & backend
                    ┌───────────────────┼─────────────────────────────┐
                    ▼                   ▼                             ▼
          Windows (win32print)   Android/Termux              PRINTER_IP set
          ZDesigner queue        Kotlin "SGN Print          TCP :9100 socket
                    │             Bridge" @127.0.0.1:6001          │
                    └───────────────┼───────────────────────────────┘
                                    ▼
                           Zebra ZD230 (rasterizes ZPL itself)

Browser fallback (no NEXT_PUBLIC_PRINT_BRIDGE_URL, or bridge unreachable):
   printLabelsViaIframe() → hidden iframe with exact 50×25 mm @page → browser print dialog
```

### Client side (`lib/print-bridge.ts`)
- `PRINT_BRIDGE_URL` is read from `NEXT_PUBLIC_PRINT_BRIDGE_URL`.
- `sendToPrintBridge()` POSTs JSON to `POST /api/print/zpl/`.
  - If the bridge is configured but **unreachable** → computes the iframe fallback **and warns** ("Fell back to the browser print dialog").
  - If the bridge is reachable but the **printer failed** (HTTP error) → surfaces the real reason (offline/printer error), does **not** silently fall back.
- `printLabelsViaIframe()` — a fully isolated `<iframe>` document containing only the labels with `@page { size: 50mm 25mm }`, `window.print()` invoked after paint, and cleanup on `afterprint`.
- A `useRef` (`isPrintingRef`) serializes printing so rapid double-clicks / Generate+Reprint can't overlap jobs.

### Bridge side (`printer-bridge/app.py`)
The same `app.py` runs unchanged on three host types; the send path is **derived from real platform signals**, never from env vars alone:
- `detect_platform()` → `windows` / `android` (Termux `PREFIX` or `/data/data/com.termux`) / `linux`.
- `select_backend()` → **`PRINTER_IP` first** (TCP 9100 on any platform), else Android → Kotlin bridge, Windows → win32print/CUPS, Linux → CUPS.
- `build_token_zpl()` renders the approved label design in raw ZPL — hospital name (auto-wrapped using Zebra Font-A advance metrics), `TOKEN` caption, and a big fixed-size number — sized from the physical 50×25 mm label in dots (400×200 at 203 dpi).
- Print backends fail loudly (win32print status flags, CUPS job verification, socket connect) so the web app never gets a false "success" — `LAST_PRINT_OK_AT` / failures are tracked for diagnostics.

---

## 12. Kotlin Application Integration (SGN Print Bridge)

The **SGN Print Bridge is a native Android (Kotlin) application** that lives as a *separate Android project* from this web repository. It exists because **Termux's USB sandbox breaks direct `libusb` access** (`LIBUSB_ERROR_IO`) — raw `pyusb` enumeration simply cannot reach the ZD230 inside Termux. The Kotlin app solves this by owning the printer itself.

### What the Kotlin app does
1. Runs as an **Android foreground service** on the Sunmi T2s Lite tablet (persistent, restart-safe).
2. Uses **Zebra's Link-OS SDK** to discover and talk to the ZD230 over **USB** (VID `0x0A5F`).
3. Exposes a tiny **local HTTP server bound to `127.0.0.1:6001`**.
4. Accepts **raw ZPL bytes as the HTTP POST body** (not JSON), prints **one label per POST**, and responds `200` on success or a non-200 body with the actual reason (e.g. "USB permission not granted", "Printer not found", Zebra SDK exception).

### How it is wired into the web application

```
Dispensing browser                           printer-bridge/app.py (Termux)
┌──────────────────────────┐   HTTP POST    ┌─────────────────────────────┐   HTTP POST (raw ZPL)  ┌──────────────────────────┐
│  sendToPrintBridge()     │ ─────────────► │  POST /api/print/zpl/      │ ─────────────────────► │ SGN Print Bridge (Kotlin)│
│  NEXT_PUBLIC_PRINT_      │                │  detect_platform()="android"│                        │ 127.0.0.1:6001           │
│  BRIDGE_URL: localhost:5000│               │  select_backend()="usb"    │  retry 5× / 2s         │  Zebra Link-OS SDK        │
└──────────────────────────┘                └─────────────────────────────┘                        │  USB ──► ZD230            │
                                       retries: ANDROID_BRIDGE_RETRIES=5,      └──────────────────────────┘
                                       ANDROID_BRIDGE_RETRY_DELAY_S=2
                                       timeout: ANDROID_BRIDGE_TIMEOUT_S=10
```

### Interaction contract (constant values in `printer-bridge/app.py`)
| Item | Value |
|---|---|
| Kotlin service endpoint | `http://127.0.0.1:6001` |
| Request | `POST` with **raw ZPL bytes as the body** |
| Response | `200` = printed; any other status + body surfaced verbatim to the staff UI |
| Retry behaviour | 5 attempts, 2 s apart, only while the service is unreachable (boot time) |
| Per-copy request | One POST per label copy (`print_zpl_usb` loops per copy) |
| Diagnostics | `android_bridge_readiness()` — TCP connect to 127.0.0.1:6001 (2 s timeout) |

### Why this split exists
- **Web app** is cloud-hosted and knows nothing about USB.
- **Python bridge** (`app.py`) is the platform-agnostic orchestrator that renders ZPL and picks the transport.
- **Kotlin app** is the physical-interface owner on Android — it is the only component that can legally/technically touch the ZD230's USB on a rooted-free Android device, via the Zebra Link-OS SDK.

If `PRINTER_IP` is set, this Android path is skipped entirely and the ZD230 is reached over TCP 9100 instead (works from Android too).

---

## 13. Reports & Daily Auto-Reset

1. Every day at **11:40 PM IST** the Vercel Cron triggers `GET /api/cron/daily-reset` (Bearer `CRON_SECRET`).
2. RPC **`reset_day()`**:
   - Aggregates the day's totals (`total`, `first_token`, `last_token`, per-counter entry counts, payment/dispatch completions).
   - Inserts the snapshot into **`daily_summaries`**.
   - Deletes today's `tokens` (the board begins tomorrow empty).
   - Returns the stats snapshot.
3. **`emailDailyReport()`** (Nodemailer) sends supervisors a nicely formatted HTML summary **with a CSV attachment** (`sgn-report-YYYY-MM-DD.csv`) to `REPORT_RECIPIENTS` ("supervisor.trc@sgnpharmacy.com", "manager.trc@sgnpharmacy.com").
4. Admins can also trigger **Download CSV** and **Email now** from the Admin Dashboard (server actions calling the same builders, role-guarded).

---

## 14. Deployment

### Cloud (primary)
- **Frontend/Backend:** Next.js app deployed to **Vercel** (project `sgn-pharmacy`, domain `sgn-pharmacy-token-system.v0.build`). `vercel.json` provides the Cron schedule.
- **Database/Auth/Realtime:** **Supabase** project `hrsezjjbattfqhluxtnk` hosting PostgreSQL, Auth, and Realtime. Schema (tables + RPC functions) is applied via the Supabase SQL console.
- **Email:** SMTP (Gmail or any provider) configured via environment variables.

### Local print infra
- **Case A (Windows):** run `python app.py` on the PC attached to the ZD230; set `PRINTER_NAME`; optionally set `BRIDGE_HOST=127.0.0.1`.
- **Case B (Sunmi/Android):** install + start the **Kotlin SGN Print Bridge** app (foreground service), then `python app.py` inside Termux (no printer env vars needed).
- **Case C (networked ZD230):** set `PRINTER_IP` and run `app.py` anywhere.
- **Firewall note:** bind bridge to `0.0.0.0` to allow the kiosk's browsers on other devices to reach it, and set `NEXT_PUBLIC_PRINT_BRIDGE_URL` to `http://<LAN_IP>:5000`.

### Build & runs
```bash
npm install           # or pnpm install
npm run dev           # local development
npm run build && npm start   # production build
pnpm lint             # eslint
cd printer-bridge && uv run python app.py   # local print bridge
```

---

## 15. Configuration Reference

**Application (web) environment variables** (values stored in `.env` / Vercel — never commit real secrets):
| Variable | Who | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | client+server | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client+server | Public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | Admin client (provision accounts, admin RPCs, cron) |
| `SUPABASE_JWT_SECRET` | server | JWT secret used by Supabase |
| `CRON_SECRET` | server | Auths the daily-reset cron route |
| `SMTP_HOST/PORT/USER/PASSWORD/FROM` | server | Daily report email |
| `NEXT_PUBLIC_PRINT_BRIDGE_URL` | client | Local bridge URL; blank → browser print dialog |
| `NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL`, `V0_RUNTIME_URL`, `V0_CALLBACK_URL` | dev | v0.app development/redirect wiring |
| `POSTGRES_URL` etc. | server | Pooled direct DB access (for migrations/scripts) |

**Print bridge environment variables** (`printer-bridge/app.py`):
| Variable | Purpose |
|---|---|
| `PRINTER_NAME` | Windows win32print queue or CUPS queue name (never used on Android) |
| `PRINTER_IP` / `PRINTER_HOST` | Networked ZD230 — forces TCP 9100 on any platform |
| `PRINTER_PORT` | Raw socket port (default 9100) |
| `PRINTER_DPI` | Default 203 |
| `ZPL_WIDTH_MM` / `ZPL_HEIGHT_MM` | Physical label size (default 50 × 25 mm) |
| `UPLOAD_FOLDER` | Scratch dir for legacy image path |
| `BRIDGE_HOST` / `BRIDGE_PORT` | Bind address (default 0.0.0.0) and port (default 5000) |

---

## 16. Security Considerations

- **Role enforcement on every mutation:** every Server Action re-derives the Supabase user from cookies and checks `profiles.role` beyond the redirect guard (`requireAdmin`, per-action checks).
- **Service-role key is server-only:** it is never exposed to the browser; only `NEXT_PUBLIC_*` keys are shipped to the client (restricted by Supabase RLS policies on the database side).
- **Session refresh via middleware:** access tokens kept in cookies; `updateSession()` refreshes them on the fly.
- **Cron protection:** the daily-reset route requires `Authorization: Bearer CRON_SECRET`.
- **Public surface minimized:** only `/`, `/auth/*` and `/display` are public routes; `/display` intentionally needs no login but discloses only the live "Now Serving" numbers.
- **Control characters escaped in ZPL:** the bridge strips ZPL-special characters (`^`, `~`) from text before printing to prevent ZPL injection.
- **Real secrets are never committed** — `/.env` is git-ignored; only `.env.example` with placeholders is tracked.

---

*End of Technical Documentation — SGN Token System*