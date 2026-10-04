-- Manager venue scope: one selected venue per authenticated session.
create schema if not exists private;

-- Authenticated users may resolve the private authorization helpers, but
-- remain unable to access any private tables directly.
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.can_access_venue(p_venue_id bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = (select auth.uid()) and p.status = 'active'
      and (p.role = 'owner' or (p.venue_id = p_venue_id and
        (p.role <> 'manager' or exists (
          select 1 from public.user_venue_access uva
          where uva.user_id = p.user_id and uva.venue_id = p_venue_id
        ))))
  );
$$;
revoke all on function private.can_access_venue(bigint) from public;
grant execute on function private.can_access_venue(bigint) to authenticated;

create or replace function public.select_manager_venue(p_venue_id bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare selected_id bigint;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  select uva.venue_id into selected_id
  from public.profiles p
  join public.user_venue_access uva on uva.user_id = p.user_id
  join public.venues v on v.id = uva.venue_id and v.business_id = p.business_id and v.is_active
  where p.user_id = (select auth.uid()) and p.status = 'active'
    and p.role = 'manager' and uva.venue_id = p_venue_id;
  if selected_id is null then raise exception 'Venue access denied'; end if;
  update public.profiles set venue_id = selected_id, updated_at = now()
  where user_id = (select auth.uid()) and role = 'manager' and status = 'active';
  return selected_id;
end;
$$;
revoke all on function public.select_manager_venue(bigint) from public, anon;
grant execute on function public.select_manager_venue(bigint) to authenticated;

drop policy if exists profiles_manage on public.profiles;
create policy profiles_manage on public.profiles for update to authenticated
using (business_id = private.current_business_id() and private.current_role() = 'owner')
with check (business_id = private.current_business_id() and private.current_role() = 'owner');

drop policy if exists user_venue_access_manage on public.user_venue_access;
create policy user_venue_access_manage on public.user_venue_access for all to authenticated
using (private.current_role() = 'owner') with check (private.current_role() = 'owner');

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'attendance_sessions','finance_entries','game_shift_reports',
    'kiosk_monthly_bills','kiosk_payments','kiosks','loto_area_attendance',
    'loto_bonus_settlements','salary_advance_requests','shifts','staff_schedules',
    'ticket_inventory','venue_ticket_sources','weekly_payrolls','weekly_staff_schedules'
  ] loop
    execute format('drop policy if exists manager_venue_scope on public.%I', table_name);
    execute format('create policy manager_venue_scope on public.%I as restrictive for all to authenticated using (private.can_access_venue(venue_id)) with check (private.can_access_venue(venue_id))', table_name);
  end loop;
end $$;

-- Tặng phẩm là danh mục dùng chung trong cùng công ty. Không áp phạm vi sân khấu
-- cho bảng này; người làm File Vé chỉ được đọc các lựa chọn thuộc business của họ.
drop policy if exists manager_venue_scope on public.gift_options;
drop policy if exists gift_options_company_scope on public.gift_options;
create policy gift_options_company_scope on public.gift_options
as restrictive for select to authenticated
using (business_id = private.current_business_id());

drop policy if exists manager_venue_scope on public.shift_staff;
create policy manager_venue_scope on public.shift_staff as restrictive for all to authenticated
using (exists (select 1 from public.shifts s where s.id=shift_staff.shift_id and private.can_access_venue(s.venue_id)))
with check (exists (select 1 from public.shifts s where s.id=shift_staff.shift_id and private.can_access_venue(s.venue_id)));

drop policy if exists manager_venue_scope on public.ticket_rounds;
create policy manager_venue_scope on public.ticket_rounds as restrictive for all to authenticated
using (exists (select 1 from public.shifts s where s.id=ticket_rounds.shift_id and private.can_access_venue(s.venue_id)))
with check (exists (select 1 from public.shifts s where s.id=ticket_rounds.shift_id and private.can_access_venue(s.venue_id)));

drop policy if exists manager_venue_scope on public.ticket_round_codes;
create policy manager_venue_scope on public.ticket_round_codes as restrictive for all to authenticated
using (exists (select 1 from public.ticket_rounds r join public.shifts s on s.id=r.shift_id where r.id=ticket_round_codes.round_id and private.can_access_venue(s.venue_id)))
with check (exists (select 1 from public.ticket_rounds r join public.shifts s on s.id=r.shift_id where r.id=ticket_round_codes.round_id and private.can_access_venue(s.venue_id)));

drop policy if exists manager_venue_scope on public.ticket_sales;
create policy manager_venue_scope on public.ticket_sales as restrictive for all to authenticated
using (exists (select 1 from public.ticket_rounds r join public.shifts s on s.id=r.shift_id where r.id=ticket_sales.round_id and private.can_access_venue(s.venue_id)))
with check (exists (select 1 from public.ticket_rounds r join public.shifts s on s.id=r.shift_id where r.id=ticket_sales.round_id and private.can_access_venue(s.venue_id)));

drop policy if exists manager_venue_scope on public.expenses;
create policy manager_venue_scope on public.expenses as restrictive for all to authenticated
using (exists (select 1 from public.shifts s where s.id=expenses.shift_id and private.can_access_venue(s.venue_id)))
with check (exists (select 1 from public.shifts s where s.id=expenses.shift_id and private.can_access_venue(s.venue_id)));

drop policy if exists manager_venue_scope on public.revenues;
create policy manager_venue_scope on public.revenues as restrictive for all to authenticated
using (exists (select 1 from public.shifts s where s.id=revenues.shift_id and private.can_access_venue(s.venue_id)))
with check (exists (select 1 from public.shifts s where s.id=revenues.shift_id and private.can_access_venue(s.venue_id)));
