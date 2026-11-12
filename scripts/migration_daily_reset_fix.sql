-- ============================================================
-- Migration: Display board shows only TODAY + reliable daily reset
-- ============================================================
-- Problem: the nightly reset (Vercel cron → reset_day()) did not run, so
-- yesterday's tokens stayed in the table. Stations only show today's tokens
-- (numbering restarts at 1), but display_board() had no date filter, so a
-- token left "serving" yesterday stayed on the TV permanently.
--
-- Fix (same day-by-day behaviour as before, just robust):
--   1. display_board() only returns TODAY's tokens (IST).
--   2. reset_day() also archives + clears any PAST day that was missed
--      (e.g. the cron did not run, or fired after midnight), and only clears
--      today's tokens when run in the evening (after 20:00 IST) — so a late
--      or manual run can never wipe a live queue.
--   3. Clears the leftover tokens from previous days right now (they are
--      archived into daily_summaries first). Today's queue is untouched.
--
-- HOW TO RUN: Supabase → SQL Editor → paste → Run. Safe to re-run.
-- ============================================================

-- ─── 1. display_board: today only ───────────────────────────
CREATE OR REPLACE FUNCTION public.display_board()
RETURNS TABLE (station text, counter integer, token_number integer,
               called_at timestamptz, recalled_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH t AS (SELECT * FROM public.tokens WHERE service_date = public.ist_today())
  SELECT 'entry', 1, token_number, entry_called_at, entry_recalled_at
  FROM t WHERE status = 'entry_serving' AND entry_counter = 1
  UNION ALL
  SELECT 'entry', 2, token_number, entry_called_at, entry_recalled_at
  FROM t WHERE status = 'entry_serving' AND entry_counter = 2
  UNION ALL
  SELECT 'entry', 3, token_number, entry_called_at, entry_recalled_at
  FROM t WHERE status = 'entry_serving' AND entry_counter = 3
  UNION ALL
  SELECT 'entry', 4, token_number, entry_called_at, entry_recalled_at
  FROM t WHERE status = 'entry_serving' AND entry_counter = 4
  UNION ALL
  SELECT 'payment', NULL, token_number, payment_called_at, payment_recalled_at
  FROM t WHERE status = 'payment_serving'
  UNION ALL
  SELECT 'dispatch', NULL, token_number, dispatch_called_at, NULL
  FROM t WHERE status = 'dispatch_serving';
$$;
GRANT EXECUTE ON FUNCTION public.display_board() TO anon, authenticated;

-- ─── 2. Stats for any day ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.day_stats(p_date date)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'service_date',     p_date,
    'total',            count(*),
    'first_token',      min(token_number),
    'last_token',       max(token_number),
    'entry_1',          count(*) FILTER (WHERE entry_counter = 1 AND entry_completed_at IS NOT NULL),
    'entry_2',          count(*) FILTER (WHERE entry_counter = 2 AND entry_completed_at IS NOT NULL),
    'entry_3',          count(*) FILTER (WHERE entry_counter = 3 AND entry_completed_at IS NOT NULL),
    'entry_4',          count(*) FILTER (WHERE entry_counter = 4 AND entry_completed_at IS NOT NULL),
    'entry_done',       count(*) FILTER (WHERE entry_completed_at IS NOT NULL),
    'payment_done',     count(*) FILTER (WHERE payment_completed_at IS NOT NULL),
    'dispatch_done',    count(*) FILTER (WHERE status = 'completed'),
    'in_progress',      count(*) FILTER (WHERE status <> 'completed'),
    'pending_entry',    count(*) FILTER (WHERE status IN ('pending_entry','entry_waiting')),
    'pending_payment',  count(*) FILTER (WHERE status = 'pending_payment'),
    'pending_dispatch', count(*) FILTER (WHERE status = 'pending_dispatch')
  )
  FROM public.tokens
  WHERE service_date = p_date;
$$;

CREATE OR REPLACE FUNCTION public.admin_stats()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.day_stats(public.ist_today());
$$;

-- ─── 3. Archive + clear one day ─────────────────────────────
CREATE OR REPLACE FUNCTION public.archive_day(p_date date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s jsonb := public.day_stats(p_date);
BEGIN
  INSERT INTO public.daily_summaries
    (service_date, total, first_token, last_token, entry_1, entry_2, entry_3, entry_4,
     entry_done, payment_done, dispatch_done, in_progress)
  VALUES
    (p_date, (s->>'total')::int, (s->>'first_token')::int, (s->>'last_token')::int,
     (s->>'entry_1')::int, (s->>'entry_2')::int, (s->>'entry_3')::int, (s->>'entry_4')::int,
     (s->>'entry_done')::int, (s->>'payment_done')::int, (s->>'dispatch_done')::int,
     (s->>'in_progress')::int)
  ON CONFLICT (service_date) DO UPDATE SET
     total = EXCLUDED.total, first_token = EXCLUDED.first_token, last_token = EXCLUDED.last_token,
     entry_1 = EXCLUDED.entry_1, entry_2 = EXCLUDED.entry_2, entry_3 = EXCLUDED.entry_3,
     entry_4 = EXCLUDED.entry_4, entry_done = EXCLUDED.entry_done,
     payment_done = EXCLUDED.payment_done, dispatch_done = EXCLUDED.dispatch_done,
     in_progress = EXCLUDED.in_progress, created_at = now();
  DELETE FROM public.tokens WHERE service_date = p_date;
  RETURN s;
END;
$$;

-- ─── 4. Nightly reset (called by the Vercel cron) ───────────
-- Archives every past day still in the table, plus today when run in the
-- evening. Returns the stats of the most recent day it archived (that's what
-- the report email is about), or today's live stats if nothing was archived.
CREATE OR REPLACE FUNCTION public.reset_day()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  today   date := public.ist_today();
  evening boolean := (now() AT TIME ZONE 'Asia/Kolkata')::time >= time '20:00';
  d       date;
  v_last  jsonb;
BEGIN
  FOR d IN
    SELECT DISTINCT service_date FROM public.tokens
     WHERE service_date < today OR (evening AND service_date = today)
     ORDER BY service_date
  LOOP
    v_last := public.archive_day(d);
  END LOOP;
  RETURN COALESCE(v_last, public.day_stats(today));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.day_stats(date)   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.archive_day(date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_stats()     FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reset_day()       FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.day_stats(date)   TO service_role;
GRANT  EXECUTE ON FUNCTION public.archive_day(date) TO service_role;
GRANT  EXECUTE ON FUNCTION public.admin_stats()     TO service_role;
GRANT  EXECUTE ON FUNCTION public.reset_day()       TO service_role;

-- ─── 5. Clean up the days that were missed (today is kept) ──
DO $$
DECLARE d date;
BEGIN
  FOR d IN SELECT DISTINCT service_date FROM public.tokens
            WHERE service_date < public.ist_today() ORDER BY 1
  LOOP
    PERFORM public.archive_day(d);
  END LOOP;
END $$;

-- ─── Check ──────────────────────────────────────────────────
-- SELECT * FROM public.display_board();            -- today's tokens only
-- SELECT * FROM public.daily_summaries;             -- missed days archived
-- SELECT service_date, count(*) FROM public.tokens GROUP BY 1;  -- only today
