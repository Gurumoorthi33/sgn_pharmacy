-- ============================================================
-- Migration: Fix "Call Again" (recall) for Entry 1-4 + Payment,
--             and add Entry Counter 4 to the Display Board.
-- ============================================================
-- What it does:
--   1. Adds entry_recalled_at / payment_recalled_at columns (idempotent)
--   2. Creates recall_entry(p_id) / recall_payment(p_id) RPCs
--   3. Rebuilds display_board() to:
--        • return recalled_at for entry + payment (drives the TTS re-announce)
--        • include ALL 4 entry counters (Entry Counter 4 tile)
--   4. Grants EXECUTE to the app roles.
--
-- HOW TO RUN: Supabase Dashboard → SQL Editor → paste → Run.
--   (Safe to run more than once.)
-- ============================================================

-- ─── 1. recall columns (idempotent) ─────────────────────────
ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS entry_recalled_at timestamptz;

ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS payment_recalled_at timestamptz;

-- ─── 2. recall_entry RPC ────────────────────────────────────
-- Re-announces the token currently serving at an entry counter by stamping
-- entry_recalled_at with now(). Does NOT change entry_called_at, status, or
-- entry_counter — purely a re-announce signal. The display board's entry
-- recall watcher keys off this column. Only acts on entry_serving tokens.
DROP FUNCTION IF EXISTS public.recall_entry(uuid);

CREATE OR REPLACE FUNCTION public.recall_entry(p_id uuid)
RETURNS SETOF public.tokens
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.tokens
  SET    entry_recalled_at = now()
  WHERE  id = p_id
    AND  status = 'entry_serving'
  RETURNING *;
$$;

GRANT EXECUTE ON FUNCTION public.recall_entry(uuid) TO authenticated;

-- ─── 3. recall_payment RPC ──────────────────────────────────
-- Re-announces the token currently serving at the payment counter by stamping
-- payment_recalled_at with now(). The display board's payment recall watcher
-- keys off this column. Only acts on payment_serving tokens.
DROP FUNCTION IF EXISTS public.recall_payment(uuid);

CREATE OR REPLACE FUNCTION public.recall_payment(p_id uuid)
RETURNS SETOF public.tokens
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.tokens
  SET    payment_recalled_at = now()
  WHERE  id = p_id
    AND  status = 'payment_serving'
  RETURNING *;
$$;

GRANT EXECUTE ON FUNCTION public.recall_payment(uuid) TO authenticated;

-- ─── 4. display_board RPC (Entry 1-4 + recalled_at) ─────────
-- Returns one row per ACTIVE station:
--   entry × 4 counters, payment, dispatch.
-- called_at  → the *_called_at column (triggers on a NEW call)
-- recalled_at→ the *_recalled_at column (triggers ONLY on "Call Again")
-- Dispatch has no recalled_at column; it re-announces via dispatch_called_at,
-- so its recalled_at is returned NULL (the dispatch watcher keys on called_at).
DROP FUNCTION IF EXISTS public.display_board();

CREATE OR REPLACE FUNCTION public.display_board()
RETURNS TABLE (
  station      text,
  counter      integer,
  token_number integer,
  called_at    timestamptz,
  recalled_at  timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 'entry', 1, token_number, entry_called_at, entry_recalled_at
  FROM public.tokens WHERE status = 'entry_serving' AND entry_counter = 1

  UNION ALL

  SELECT 'entry', 2, token_number, entry_called_at, entry_recalled_at
  FROM public.tokens WHERE status = 'entry_serving' AND entry_counter = 2

  UNION ALL

  SELECT 'entry', 3, token_number, entry_called_at, entry_recalled_at
  FROM public.tokens WHERE status = 'entry_serving' AND entry_counter = 3

  UNION ALL

  SELECT 'entry', 4, token_number, entry_called_at, entry_recalled_at
  FROM public.tokens WHERE status = 'entry_serving' AND entry_counter = 4

  UNION ALL

  SELECT 'payment', NULL, token_number, payment_called_at, payment_recalled_at
  FROM public.tokens WHERE status = 'payment_serving'

  UNION ALL

  SELECT 'dispatch', NULL, token_number, dispatch_called_at, NULL
  FROM public.tokens WHERE status = 'dispatch_serving';
$$;

GRANT EXECUTE ON FUNCTION public.display_board() TO anon, authenticated;

-- ─── 5. OPTIONAL — include Counter 4 in the emailed CSV ─────
-- The live Admin Dashboard already computes Counter 4 client-side, so it works
-- immediately. The emailed/CSV per-counter breakdown is produced by the
-- admin_stats() RPC, which this migration intentionally leaves untouched to
-- avoid guessing its exact definition.
--
-- To also show "Entry Counter 4 served" in the emailed report, extend your
-- admin_stats(), reset_day() and daily_summaries with an entry_4 column,
-- mirroring the existing entry_1/entry_2/entry_3 columns.

-- ─── 6. Create the 4th entry counter staff account (data) ───
-- In the Supabase Dashboard → Authentication → Users, add a user (e.g.
-- username e4@<domain>), then in Profiles set:
--   username  = e4
--   role      = entry
--   counter   = 4
-- They will then land on /entry bound to Entry Counter 4.

-- ─── Sanity checks ──────────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'tokens'
--     AND column_name IN ('entry_recalled_at','payment_recalled_at');
--
-- SELECT proname FROM pg_proc WHERE proname IN ('recall_entry','recall_payment');
--
-- SELECT * FROM public.display_board();