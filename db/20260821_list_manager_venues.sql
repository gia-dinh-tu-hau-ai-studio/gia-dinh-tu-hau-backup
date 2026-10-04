-- Return only active venues explicitly assigned to the signed-in manager.
-- Needed before venue selection because venue-scoped RLS hides unselected venues.
create or replace function public.list_manager_venues()
returns table (
  id bigint,
  name text,
  attendance_latitude double precision,
  attendance_longitude double precision,
  attendance_radius_m integer,
  attendance_wifi_ips text[],
  attendance_configured_at timestamptz,
  is_active boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    v.id,
    v.name,
    v.attendance_latitude,
    v.attendance_longitude,
    v.attendance_radius_m,
    v.attendance_wifi_ips,
    v.attendance_configured_at,
    v.is_active
  from public.profiles p
  join public.user_venue_access uva on uva.user_id = p.user_id
  join public.venues v
    on v.id = uva.venue_id
   and v.business_id = p.business_id
   and v.is_active
  where p.user_id = (select auth.uid())
    and p.status = 'active'
    and p.role = 'manager'
  order by v.name;
$$;

revoke all on function public.list_manager_venues() from public, anon;
grant execute on function public.list_manager_venues() to authenticated;