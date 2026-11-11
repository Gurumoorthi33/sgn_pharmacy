-- ============================================================
-- Migration: Reduce Supabase egress (bandwidth)
-- ============================================================
-- What it does (no change to token workflow, RPCs or the board's content):
--   1. Index for the "today's tokens" queries used by every station.
--   2. Pushes the Display Board's 6 "Now Serving" rows to the public
--      Realtime broadcast channel "display-board" whenever a token change
--      could affect the board. The TV screens then stop polling every 3 s.
--      The payload is exactly what display_board() returns.
--   3. (Optional, commented out) retention safety net.
--
-- HOW TO RUN: Supabase Dashboard → SQL Editor → paste → Run.
--   (Safe to run more than once.)
--
-- The app keeps working if this is NOT run — the display simply keeps its
-- original 3-second polling.
-- ============================================================

-- ─── 1. Index for station queries ───────────────────────────
-- Stations fetch: WHERE service_date = today [AND status <> 'completed']
CREATE INDEX IF NOT EXISTS tokens_service_date_status_idx
  ON public.tokens (service_date, status);

-- ─── 2. Broadcast the display board on change ───────────────
CREATE OR REPLACE FUNCTION public.broadcast_display_board()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    PERFORM realtime.send(
      jsonb_build_object(
        'rows',
        COALESCE((SELECT jsonb_agg(to_jsonb(d)) FROM public.display_board() d), '[]'::jsonb)
      ),
      'board',          -- event name (listened to by the display board)
      'display-board',  -- topic / channel name
      false             -- public channel: the TV screens are not logged in
    );
  EXCEPTION WHEN OTHERS THEN
    -- Never let a broadcast problem block a token action.
    RAISE WARNING 'broadcast_display_board failed: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tokens_display_board_broadcast_upd ON public.tokens;
DROP TRIGGER IF EXISTS tokens_display_board_broadcast_del ON public.tokens;

-- Statement-level: one broadcast per statement (the nightly reset deletes many
-- rows but sends one message). Only columns the board shows / keys off.
-- INSERT is skipped: new tokens are 'pending_entry' and never on the board.
CREATE TRIGGER tokens_display_board_broadcast_upd
  AFTER UPDATE OF status, entry_counter, token_number,
                  entry_called_at, entry_recalled_at,
                  payment_called_at, payment_recalled_at,
                  dispatch_called_at
  ON public.tokens
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.broadcast_display_board();

CREATE TRIGGER tokens_display_board_broadcast_del
  AFTER DELETE ON public.tokens
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.broadcast_display_board();

-- ─── 3. OPTIONAL — retention safety net ─────────────────────
-- reset_day() (Vercel cron, 11:40 PM IST) already deletes each day's tokens
-- after saving the summary, so the table stays small. If the cron ever fails,
-- old days would linger (the stations only read today's rows, so this only
-- affects table size, not egress). Uncomment ONLY if you are happy for
-- leftover past-day tokens to be removed without a daily_summaries entry.
--
-- DELETE FROM public.tokens
--  WHERE service_date < (now() AT TIME ZONE 'Asia/Kolkata')::date;

-- ─── Sanity checks ──────────────────────────────────────────
-- Tokens table is in the realtime publication (stations need this):
--   SELECT * FROM pg_publication_tables
--    WHERE pubname = 'supabase_realtime' AND tablename = 'tokens';
-- Triggers exist:
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.tokens'::regclass;
-- Leftover past-day tokens (should be 0):
--   SELECT count(*) FROM public.tokens
--    WHERE service_date < (now() AT TIME ZONE 'Asia/Kolkata')::date;
