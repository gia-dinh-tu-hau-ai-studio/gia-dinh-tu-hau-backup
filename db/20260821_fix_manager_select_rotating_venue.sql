create or replace function public.select_manager_venue(p_venue_id bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  selected_id bigint;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  select v.id into selected_id
  from public.profiles p
  join public.user_venue_access uva
    on uva.user_id = p.user_id
   and uva.venue_id = p_venue_id
  join public.venues v
    on v.id = uva.venue_id
   and v.business_id = p.business_id
   and v.is_active
  where p.user_id = (select auth.uid())
    and p.status = 'active'
    and p.role = 'manager'
  limit 1;

  if selected_id is null then
    raise exception 'Venue access denied';
  end if;

  update public.profiles
  set venue_id = selected_id
  where user_id = (select auth.uid())
    and role = 'manager'
    and status = 'active';

  return selected_id;
end;
$function$;

revoke all on function public.select_manager_venue(bigint) from public;
grant execute on function public.select_manager_venue(bigint) to authenticated;