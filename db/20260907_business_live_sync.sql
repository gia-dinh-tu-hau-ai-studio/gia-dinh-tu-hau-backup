create table if not exists public.business_sync_events (
  business_id bigint not null,
  source_table text not null,
  venue_id bigint not null default 0,
  actor_user_id uuid,
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (business_id, source_table, venue_id)
);

alter table public.business_sync_events enable row level security;
revoke all on public.business_sync_events from public, anon;
grant select on public.business_sync_events to authenticated;
drop policy if exists business_sync_events_read_own_business on public.business_sync_events;
create policy business_sync_events_read_own_business on public.business_sync_events
  for select to authenticated using (business_id=(select private.current_business_id()));

create or replace function private.emit_business_sync_event()
returns trigger language plpgsql security definer set search_path to '' as $$
declare
  row_data jsonb:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_business_id bigint; v_venue_id bigint:=0; v_round_id bigint; v_shift_id bigint;
begin
  v_business_id:=nullif(row_data->>'business_id','')::bigint;
  v_venue_id:=coalesce(nullif(row_data->>'venue_id','')::bigint,0);
  if v_business_id is null and tg_table_name in ('ticket_round_codes','ticket_sales') then
    v_round_id:=nullif(row_data->>'round_id','')::bigint;
    select r.business_id,coalesce(s.venue_id,0) into v_business_id,v_venue_id from public.ticket_rounds r join public.shifts s on s.id=r.shift_id where r.id=v_round_id;
  elsif v_business_id is null and tg_table_name='shift_staff' then
    v_shift_id:=nullif(row_data->>'shift_id','')::bigint;
    select s.business_id,coalesce(s.venue_id,0) into v_business_id,v_venue_id from public.shifts s where s.id=v_shift_id;
  end if;
  if v_business_id is null then return coalesce(new,old); end if;
  insert into public.business_sync_events(business_id,source_table,venue_id,actor_user_id)
  values(v_business_id,tg_table_name,v_venue_id,auth.uid())
  on conflict(business_id,source_table,venue_id) do update set actor_user_id=excluded.actor_user_id,revision=public.business_sync_events.revision+1,updated_at=now();
  return coalesce(new,old);
end $$;

-- Only operational data publishes a live-sync event. Backups and supporting
-- tables are intentionally excluded to keep normal page loading and saving fast.
do $$
declare v_table text;
begin
  foreach v_table in array array[
    'shifts','shift_staff','ticket_shift_drafts','ticket_rounds','ticket_round_codes','ticket_sales','ticket_inventory',
    'finance_entries','game_shift_reports','game_ticket_inventory','game_ticket_inventory_transactions',
    'kiosks','kiosk_monthly_bills','kiosk_payments','employees','profiles',
    'staff_competition_violations','staff_monthly_scores','staff_off_requests','staff_schedules','weekly_staff_schedules',
    'salary_advance_requests','fixed_expense_obligations','go_an_lac_night_rewards','loto_area_attendance',
    'venue_loto_bonus_settings','costume_submissions','costume_monthly_scores'
  ] loop
    execute format('drop trigger if exists business_live_sync_trigger on public.%I',v_table);
    execute format('create trigger business_live_sync_trigger after insert or update or delete on public.%I for each row execute function private.emit_business_sync_event()',v_table);
  end loop;
end $$;

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='business_sync_events') then alter publication supabase_realtime add table public.business_sync_events; end if;
end $$;
