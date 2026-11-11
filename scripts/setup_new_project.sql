-- ============================================================
-- SGN Token System — full database setup for a NEW Supabase project
-- ============================================================
-- The original project (hrsezjjbattfqhluxtnk) was deleted and its schema was
-- never exported, so this file RECONSTRUCTS it from the app code
-- (lib/types.ts, the server actions, the boards) and TECHNICAL_DOCUMENTATION.md.
-- Table/column/function names and signatures match exactly what the app calls.
-- Function bodies follow the documented behaviour; test the whole flow once
-- (Generate → Entry → Payment → Dispatch → Display) before going live.
--
-- Includes: tables, indexes, RLS policies, all RPC functions, grants,
-- realtime publication, and the display-board broadcast trigger
-- (scripts/migration_egress.sql is already folded in).
--
-- HOW TO RUN: new project → SQL Editor → paste all → Run. Safe to re-run.
-- ============================================================

-- ─── 1. Tables ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.profiles (
  id         uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  username   text UNIQUE NOT NULL,
  full_name  text NOT NULL DEFAULT '',
  role       text NOT NULL DEFAULT 'entry'
             CHECK (role IN ('dispensing','entry','payment','dispatch','display','admin')),
  counter    integer CHECK (counter BETWEEN 1 AND 4),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tokens (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_number         integer NOT NULL,
  service_date         date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date,
  status               text NOT NULL DEFAULT 'pending_entry'
                       CHECK (status IN ('pending_entry','entry_serving','entry_waiting',
                                         'pending_payment','payment_serving','payment_waiting',
                                         'pending_dispatch','dispatch_serving','completed')),
  entry_counter        integer CHECK (entry_counter BETWEEN 1 AND 4),
  created_at           timestamptz NOT NULL DEFAULT now(),
  entry_called_at      timestamptz,
  entry_recalled_at    timestamptz,
  entry_completed_at   timestamptz,
  payment_called_at    timestamptz,
  payment_recalled_at  timestamptz,
  payment_completed_at timestamptz,
  dispatch_called_at   timestamptz,
  dispatch_requeued_at timestamptz,
  completed_at         timestamptz,
  UNIQUE (service_date, token_number)
);

CREATE INDEX IF NOT EXISTS tokens_service_date_status_idx
  ON public.tokens (service_date, status);

CREATE TABLE IF NOT EXISTS public.daily_summaries (
  service_date  date PRIMARY KEY,
  total         integer NOT NULL DEFAULT 0,
  first_token   integer,
  last_token    integer,
  entry_1       integer NOT NULL DEFAULT 0,
  entry_2       integer NOT NULL DEFAULT 0,
  entry_3       integer NOT NULL DEFAULT 0,
  entry_4       integer NOT NULL DEFAULT 0,
  entry_done    integer NOT NULL DEFAULT 0,
  payment_done  integer NOT NULL DEFAULT 0,
  dispatch_done integer NOT NULL DEFAULT 0,
  in_progress   integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── 2. Row Level Security ──────────────────────────────────
-- All writes go through SECURITY DEFINER RPCs, so no insert/update/delete
-- policies are needed. The display board (anon) reads only via display_board().

ALTER TABLE public.profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokens          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_summaries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles: read own" ON public.profiles;
CREATE POLICY "profiles: read own" ON public.profiles
  FOR SELECT TO authenticated USING (id = auth.uid());

DROP POLICY IF EXISTS "tokens: staff read" ON public.tokens;
CREATE POLICY "tokens: staff read" ON public.tokens
  FOR SELECT TO authenticated USING (true);

-- daily_summaries: no policies → only the service role (cron) can touch it.

-- ─── 3. Helper ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ist_today()
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date
$$;

-- ─── 4. Dispensing ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generate_token()
RETURNS public.tokens
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d   date := public.ist_today();
  v_row public.tokens;
BEGIN
  -- Serialise concurrent generation for the day so numbers never collide.
  PERFORM pg_advisory_xact_lock(hashtext('generate_token'), (d - date '2000-01-01'));
  INSERT INTO public.tokens (token_number, service_date, status)
  VALUES (COALESCE((SELECT max(token_number) FROM public.tokens WHERE service_date = d), 0) + 1,
          d, 'pending_entry')
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- ─── 5. Entry counters (1–4, shared FIFO) ───────────────────
CREATE OR REPLACE FUNCTION public.call_next_entry(p_counter integer)
RETURNS SETOF public.tokens
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  -- Counter already serving someone → nothing to do (UI disables the button).
  IF EXISTS (SELECT 1 FROM public.tokens
             WHERE status = 'entry_serving' AND entry_counter = p_counter
               AND service_date = public.ist_today()) THEN
    RETURN;
  END IF;

  SELECT id INTO v_id FROM public.tokens
   WHERE status = 'pending_entry' AND service_date = public.ist_today()
   ORDER BY token_number
   LIMIT 1
   FOR UPDATE SKIP LOCKED;   -- two counters never grab the same token
  IF v_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  UPDATE public.tokens
     SET status = 'entry_serving', entry_counter = p_counter, entry_called_at = now()
   WHERE id = v_id
  RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_entry(p_id uuid)
RETURNS SETOF public.tokens
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.tokens
     SET status = 'pending_payment', entry_completed_at = now()
   WHERE id = p_id AND status = 'entry_serving'
  RETURNING *;
$$;

-- Hold the current token, then immediately call the next fresh one.
CREATE OR REPLACE FUNCTION public.wait_and_next_entry(p_id uuid, p_counter integer)
RETURNS SETOF public.tokens
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.tokens SET status = 'entry_waiting'
   WHERE id = p_id AND status = 'entry_serving';
  RETURN QUERY SELECT * FROM public.call_next_entry(p_counter);
END;
$$;

-- Recall a held token to this counter (only if the counter is free).
CREATE OR REPLACE FUNCTION public.call_entry_token(p_id uuid, p_counter integer)
RETURNS SETOF public.tokens
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tokens
             WHERE status = 'entry_serving' AND entry_counter = p_counter
               AND service_date = public.ist_today()) THEN
    RETURN;
  END IF;
  RETURN QUERY
  UPDATE public.tokens
     SET status = 'entry_serving', entry_counter = p_counter, entry_called_at = now()
   WHERE id = p_id AND status IN ('entry_waiting', 'pending_entry')
  RETURNING *;
END;
$$;

-- Re-announce only (no queue movement). Same as scripts/migration_entry4_recall_fix.sql.
CREATE OR REPLACE FUNCTION public.recall_entry(p_id uuid)
RETURNS SETOF public.tokens
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.tokens SET entry_recalled_at = now()
   WHERE id = p_id AND status = 'entry_serving'
  RETURNING *;
$$;

-- ─── 6. Payment (single counter, FIFO by entry completion) ──
CREATE OR REPLACE FUNCTION public.call_next_payment()
RETURNS SETOF public.tokens
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.tokens
             WHERE status = 'payment_serving' AND service_date = public.ist_today()) THEN
    RETURN;
  END IF;

  SELECT id INTO v_id FROM public.tokens
   WHERE status = 'pending_payment' AND service_date = public.ist_today()
   ORDER BY entry_completed_at NULLS LAST, token_number
   LIMIT 1
   FOR UPDATE SKIP LOCKED;
  IF v_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  UPDATE public.tokens SET status = 'payment_serving', payment_called_at = now()
   WHERE id = v_id
  RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_payment(p_id uuid)
RETURNS SETOF public.tokens
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.tokens
     SET status = 'pending_dispatch', payment_completed_at = now()
   WHERE id = p_id AND status = 'payment_serving'
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION public.wait_and_next_payment(p_id uuid)
RETURNS SETOF public.tokens
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.tokens SET status = 'payment_waiting'
   WHERE id = p_id AND status = 'payment_serving';
  RETURN QUERY SELECT * FROM public.call_next_payment();
END;
$$;

CREATE OR REPLACE FUNCTION public.call_payment_token(p_id uuid)
RETURNS SETOF public.tokens
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tokens
             WHERE status = 'payment_serving' AND service_date = public.ist_today()) THEN
    RETURN;
  END IF;
  RETURN QUERY
  UPDATE public.tokens SET status = 'payment_serving', payment_called_at = now()
   WHERE id = p_id AND status IN ('payment_waiting', 'pending_payment')
  RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION public.recall_payment(p_id uuid)
RETURNS SETOF public.tokens
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.tokens SET payment_recalled_at = now()
   WHERE id = p_id AND status = 'payment_serving'
  RETURNING *;
$$;

-- ─── 7. Dispatch (single counter, manual selection) ─────────
CREATE OR REPLACE FUNCTION public.call_dispatch(p_id uuid)
RETURNS SETOF public.tokens
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tokens
             WHERE status = 'dispatch_serving' AND service_date = public.ist_today()) THEN
    RETURN;
  END IF;
  RETURN QUERY
  UPDATE public.tokens SET status = 'dispatch_serving', dispatch_called_at = now()
   WHERE id = p_id AND status = 'pending_dispatch'
  RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_dispatch(p_id uuid)
RETURNS SETOF public.tokens
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.tokens SET status = 'completed', completed_at = now()
   WHERE id = p_id AND status = 'dispatch_serving'
  RETURNING *;
$$;

-- Patient not present: back of the dispatch queue.
CREATE OR REPLACE FUNCTION public.skip_dispatch(p_id uuid)
RETURNS SETOF public.tokens
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.tokens SET status = 'pending_dispatch', dispatch_requeued_at = now()
   WHERE id = p_id AND status = 'dispatch_serving'
  RETURNING *;
$$;

-- Re-announce: a fresh dispatch_called_at re-triggers the display voice.
CREATE OR REPLACE FUNCTION public.recall_dispatch(p_id uuid)
RETURNS SETOF public.tokens
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.tokens SET dispatch_called_at = now()
   WHERE id = p_id AND status = 'dispatch_serving'
  RETURNING *;
$$;

-- ─── 8. Display board ───────────────────────────────────────
-- Identical to scripts/migration_entry4_recall_fix.sql.
DROP FUNCTION IF EXISTS public.display_board();
CREATE OR REPLACE FUNCTION public.display_board()
RETURNS TABLE (station text, counter integer, token_number integer,
               called_at timestamptz, recalled_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
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

-- ─── 9. Stats + nightly reset (service role only) ───────────
CREATE OR REPLACE FUNCTION public.admin_stats()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
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
  WHERE service_date = public.ist_today();
$$;

CREATE OR REPLACE FUNCTION public.reset_day()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d date := public.ist_today();
  s jsonb := public.admin_stats();
BEGIN
  INSERT INTO public.daily_summaries
    (service_date, total, first_token, last_token, entry_1, entry_2, entry_3, entry_4,
     entry_done, payment_done, dispatch_done, in_progress)
  VALUES
    (d, (s->>'total')::int, (s->>'first_token')::int, (s->>'last_token')::int,
     (s->>'entry_1')::int, (s->>'entry_2')::int, (s->>'entry_3')::int, (s->>'entry_4')::int,
     (s->>'entry_done')::int, (s->>'payment_done')::int, (s->>'dispatch_done')::int,
     (s->>'in_progress')::int)
  ON CONFLICT (service_date) DO UPDATE SET
     total = EXCLUDED.total, first_token = EXCLUDED.first_token, last_token = EXCLUDED.last_token,
     entry_1 = EXCLUDED.entry_1, entry_2 = EXCLUDED.entry_2, entry_3 = EXCLUDED.entry_3,
     entry_4 = EXCLUDED.entry_4, entry_done = EXCLUDED.entry_done,
     payment_done = EXCLUDED.payment_done, dispatch_done = EXCLUDED.dispatch_done,
     in_progress = EXCLUDED.in_progress, created_at = now();

  DELETE FROM public.tokens WHERE service_date = d;
  RETURN s;
END;
$$;

-- ─── 10. Grants ─────────────────────────────────────────────
-- Supabase grants EXECUTE on new public functions to anon by default; lock
-- the mutating ones down to logged-in staff, and stats/reset to the server.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'generate_token()',
    'call_next_entry(integer)', 'complete_entry(uuid)', 'wait_and_next_entry(uuid, integer)',
    'call_entry_token(uuid, integer)', 'recall_entry(uuid)',
    'call_next_payment()', 'complete_payment(uuid)', 'wait_and_next_payment(uuid)',
    'call_payment_token(uuid)', 'recall_payment(uuid)',
    'call_dispatch(uuid)', 'complete_dispatch(uuid)', 'skip_dispatch(uuid)', 'recall_dispatch(uuid)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.display_board() TO anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.admin_stats() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reset_day()   FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_stats() TO service_role;
GRANT  EXECUTE ON FUNCTION public.reset_day()   TO service_role;

-- ─── 11. Realtime ───────────────────────────────────────────
-- Stations receive live token changes via postgres_changes.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                   AND tablename = 'tokens') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tokens;
  END IF;
END $$;

-- Display board: push the 6 "Now Serving" rows to the public broadcast
-- channel "display-board" (from scripts/migration_egress.sql).
CREATE OR REPLACE FUNCTION public.broadcast_display_board()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    PERFORM realtime.send(
      jsonb_build_object('rows',
        COALESCE((SELECT jsonb_agg(to_jsonb(d)) FROM public.display_board() d), '[]'::jsonb)),
      'board', 'display-board', false);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'broadcast_display_board failed: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tokens_display_board_broadcast_upd ON public.tokens;
DROP TRIGGER IF EXISTS tokens_display_board_broadcast_del ON public.tokens;

CREATE TRIGGER tokens_display_board_broadcast_upd
  AFTER UPDATE OF status, entry_counter, token_number,
                  entry_called_at, entry_recalled_at,
                  payment_called_at, payment_recalled_at, dispatch_called_at
  ON public.tokens FOR EACH STATEMENT
  EXECUTE FUNCTION public.broadcast_display_board();

CREATE TRIGGER tokens_display_board_broadcast_del
  AFTER DELETE ON public.tokens FOR EACH STATEMENT
  EXECUTE FUNCTION public.broadcast_display_board();

-- ─── 12. Staff profiles ─────────────────────────────────────
-- Easiest: run `node scripts/create-staff.mjs scripts/staff.json` (creates the
-- auth users AND these rows). Or create users manually in
-- Authentication → Users (email = <username>@sgn.local, "Auto Confirm" on),
-- then run this (edit names / roles as needed):
--
-- INSERT INTO public.profiles (id, username, full_name, role, counter)
-- SELECT u.id, s.username, s.full_name, s.role, s.counter
-- FROM (VALUES
--   ('e1',       'Entry Counter 1', 'entry',      1),
--   ('e2',       'Entry Counter 2', 'entry',      2),
--   ('e3',       'Entry Counter 3', 'entry',      3),
--   ('e4',       'Entry Counter 4', 'entry',      4),
--   ('p1',       'Payment',         'payment',    NULL),
--   ('d1',       'Dispatch',        'dispatch',   NULL),
--   ('disp1',    'Dispensing',      'dispensing', NULL),
--   ('adminsrm', 'Administrator',   'admin',      NULL)
-- ) AS s(username, full_name, role, counter)
-- JOIN auth.users u ON u.email = s.username || '@sgn.local'
-- ON CONFLICT (id) DO UPDATE
--   SET username = EXCLUDED.username, full_name = EXCLUDED.full_name,
--       role = EXCLUDED.role, counter = EXCLUDED.counter;

-- ─── Sanity checks ──────────────────────────────────────────
-- SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1;
-- SELECT * FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
-- SELECT * FROM public.display_board();
