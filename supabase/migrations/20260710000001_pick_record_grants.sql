-- pick_record() is SECURITY DEFINER and was executable by anon/authenticated
-- through PostgREST (/rest/v1/rpc/pick_record). Nothing public calls it — the
-- api edge function invokes it with the service role — so revoke public
-- execute (flagged by the Supabase security advisor).
revoke execute on function public.pick_record() from anon, authenticated, public;
