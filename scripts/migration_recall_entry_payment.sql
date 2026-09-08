-- ============================================================
-- Migration: Add Call Again to Entry Counters + Payment counter
-- Run once in the Supabase SQL editor (Dashboard → SQL Editor).
-- ============================================================
-- Summary of changes:
--   1. Add entry_recalled_at column to tokens table
--   2. Add payment_recalled_at column to tokens table
--   3. Create recall_entry(p_id uuid) RPC
--   4. Create recall_payment(p_id uuid) RPC
--   5. Update display_board() to return recalled_at for all stations
-- ============================================================

-- ─── 1. Add entry_recalled_at column ───────────────────────────────────────
ALTER TABLE tokens
  ADD COLUMN IF NOT EXISTS entry_recalled_at timestamptz DEFAULT NULL;

-- ─── 2. Add payment_recalled_at column ─────────────────────────────────────
ALTER TABLE tokens
  ADD COLUMN IF NOT EXISTS payment_recalled_at timestamptz DEFAULT NULL;

-- ─── 3. recall_entry RPC ───────────────────────────────────────────────────
-- Re-announces the token currently serving at an entry counter by stamping
-- entry_recalled_at with now(). Does NOT change entry_called_at, status, or
-- entry_counter — purely a re-announce signal. The display board's entry
-- recall watcher keys off this column.
--
-- Only acts when the token is in entry_serving state (safety guard).
CREATE OR REPLACE FUNCTION recall_entry(p_id uuid)
RETURNS SETOF tokens
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE tokens
  SET    entry_recalled_at = now()
  WHERE  id = p_id
    AND  status = 'entry_serving'
  RETURNING *;
$$;

-- ─── 4. recall_payment RPC ─────────────────────────────────────────────────
-- Re-announces the token currently serving at the payment counter by stamping
-- payment_recalled_at with now(). Does NOT change payment_called_at, status,
-- or any queue ordering. The display board's payment recall watcher keys off
-- this column.
--
-- Only acts when the token is in payment_serving state (safety guard).
CREATE OR REPLACE FUNCTION recall_payment(p_id uuid)
RETURNS SETOF tokens
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE tokens
  SET    payment_recalled_at = now()
  WHERE  id = p_id
    AND  status = 'payment_serving'
  RETURNING *;
$$;

-- ─── 5. Update display_board() ─────────────────────────────────────────────
-- The existing display_board() RPC returns one row per active station with
-- {station, counter, token_number, called_at}. We extend it to also return
-- recalled_at so the display board can key off it independently.
--
-- IMPORTANT: Replace the body below with your actual existing display_board
-- implementation, adding the recalled_at column. The skeleton here shows the
-- expected shape — adjust the SELECT list to match whatever your current query
-- already does (JOINs, filters, etc.).
--
-- Typical pattern (adapt to match your real implementation):
--
--   SELECT
--     'entry'              AS station,
--     t.entry_counter      AS counter,
--     t.token_number,
--     t.entry_called_at    AS called_at,
--     t.entry_recalled_at  AS recalled_at   -- NEW
--   FROM tokens t
--   WHERE t.status = 'entry_serving'
--
--   UNION ALL
--
--   SELECT
--     'payment'            AS station,
--     NULL                 AS counter,
--     t.token_number,
--     t.payment_called_at  AS called_at,
--     t.payment_recalled_at AS recalled_at  -- NEW
--   FROM tokens t
--   WHERE t.status = 'payment_serving'
--
--   UNION ALL
--
--   SELECT
--     'dispatch'           AS station,
--     NULL                 AS counter,
--     t.token_number,
--     t.dispatch_called_at AS called_at,
--     NULL                 AS recalled_at   -- dispatch uses called_at directly
--   FROM tokens t
--   WHERE t.status = 'dispatch_serving'
--
-- NOTE: If display_board() is already defined and returning correct data for
-- the existing stations, you only need to add `recalled_at` to the SELECT list
-- for each branch as shown above. Dispatch can return NULL for recalled_at
-- since it already uses called_at as its re-announce signal.
--
-- Below is a DROP + CREATE skeleton — comment out if you prefer CREATE OR
-- REPLACE on your own existing implementation:

-- DROP FUNCTION IF EXISTS display_board();

-- CREATE OR REPLACE FUNCTION display_board()
-- RETURNS TABLE (
--   station     text,
--   counter     integer,
--   token_number integer,
--   called_at   timestamptz,
--   recalled_at timestamptz
-- )
-- LANGUAGE sql
-- STABLE
-- SECURITY DEFINER
-- AS $$
--   -- Entry counters (serving)
--   SELECT
--     'entry'             AS station,
--     entry_counter       AS counter,
--     token_number,
--     entry_called_at     AS called_at,
--     entry_recalled_at   AS recalled_at
--   FROM tokens
--   WHERE status = 'entry_serving'
--
--   UNION ALL
--
--   -- Payment counter (serving)
--   SELECT
--     'payment'            AS station,
--     NULL                 AS counter,
--     token_number,
--     payment_called_at    AS called_at,
--     payment_recalled_at  AS recalled_at
--   FROM tokens
--   WHERE status = 'payment_serving'
--
--   UNION ALL
--
--   -- Dispatch counter (serving)
--   SELECT
--     'dispatch'           AS station,
--     NULL                 AS counter,
--     token_number,
--     dispatch_called_at   AS called_at,
--     NULL                 AS recalled_at
--   FROM tokens
--   WHERE status = 'dispatch_serving';
-- $$;

-- ─── Quick sanity checks ────────────────────────────────────────────────────
-- After running this migration you can verify with:
--
--   SELECT column_name, data_type
--   FROM information_schema.columns
--   WHERE table_name = 'tokens'
--     AND column_name IN ('entry_recalled_at', 'payment_recalled_at');
--
--   SELECT proname FROM pg_proc
--   WHERE proname IN ('recall_entry', 'recall_payment');
