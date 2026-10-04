create table if not exists public.ticket_shift_drafts (
  shift_id bigint primary key references public.shifts(id) on delete cascade,
  business_id bigint not null,
  venue_id bigint not null references public.venues(id),
  payload jsonb not null default '{}'::jsonb,
  updated_by uuid not null default auth.uid(),
  updated_at timestamptz not null default now()
);

alter table public.ticket_shift_drafts enable row level security;

drop policy if exists ticket_shift_drafts_read on public.ticket_shift_drafts;
create policy ticket_shift_drafts_read on public.ticket_shift_drafts
for select to authenticated
using (
  business_id = private.current_business_id()
  and private.can_access_venue(venue_id)
);

drop policy if exists ticket_shift_drafts_write on public.ticket_shift_drafts;
create policy ticket_shift_drafts_write on public.ticket_shift_drafts
for all to authenticated
using (
  business_id = private.current_business_id()
  and private.can_access_venue(venue_id)
  and exists (
    select 1 from public.shifts s
    where s.id = shift_id
      and s.business_id = ticket_shift_drafts.business_id
      and s.venue_id = ticket_shift_drafts.venue_id
      and s.status = 'open'
      and (s.opened_by = (select auth.uid()) or private.current_role() = 'owner')
  )
)
with check (
  business_id = private.current_business_id()
  and private.can_access_venue(venue_id)
  and exists (
    select 1 from public.shifts s
    where s.id = shift_id
      and s.business_id = ticket_shift_drafts.business_id
      and s.venue_id = ticket_shift_drafts.venue_id
      and s.status = 'open'
      and (s.opened_by = (select auth.uid()) or private.current_role() = 'owner')
  )
);

grant select, insert, update, delete on public.ticket_shift_drafts to authenticated;

create index if not exists ticket_shift_drafts_business_venue_idx
  on public.ticket_shift_drafts(business_id, venue_id, updated_at desc);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime'
      and schemaname='public'
      and tablename='ticket_shift_drafts'
  ) then
    alter publication supabase_realtime add table public.ticket_shift_drafts;
  end if;
end;
$$;
