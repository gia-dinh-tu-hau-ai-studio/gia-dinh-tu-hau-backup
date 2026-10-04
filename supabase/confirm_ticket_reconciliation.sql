-- Owner-only confirmation for verified ticket-report variances.
-- Applied to project iatsragydcddjrxbosrx on 2026-08-16.
alter table public.ticket_rounds
  add column if not exists reconciliation_confirmed_at timestamptz,
  add column if not exists reconciliation_confirmed_by uuid references public.profiles(user_id),
  add column if not exists reconciliation_variance integer;

create or replace function private.confirm_ticket_reconciliation(p_round_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_round public.ticket_rounds%rowtype;
  v_venue_id bigint;
  v_code record;
  v_expected integer;
  v_reported integer;
  v_variance integer;
  v_inventory_ids bigint[] := array[]::bigint[];
begin
  if v_user is null or not exists (
    select 1 from public.profiles p
    where p.user_id = v_user and p.status = 'active' and p.role = 'owner'
  ) then
    raise exception 'Chỉ chủ sở hữu được xác nhận sai lệch vé';
  end if;

  select r.* into v_round
  from public.ticket_rounds r
  where r.id = p_round_id
  for update;

  if v_round.id is null or v_round.business_id <> private.current_business_id() then
    raise exception 'Không tìm thấy vòng vé trong phạm vi công ty';
  end if;

  select s.venue_id into v_venue_id
  from public.shifts s
  where s.id = v_round.shift_id and s.business_id = v_round.business_id;

  if v_venue_id is null then raise exception 'Không xác định được sân khấu của vòng vé'; end if;
  if v_round.status <> 'verified' or v_round.sold_quantity <= 0 then
    raise exception 'Chỉ xác nhận vòng đã hoàn tất báo cáo và có phát sinh bán vé';
  end if;

  if not exists (
      select 1 from public.ticket_round_codes c
      where c.round_id = p_round_id and c.cancellation_status <> 'approved'
    )
    or exists (
      select 1 from public.ticket_round_codes c
      where c.round_id = p_round_id
        and c.cancellation_status <> 'approved'
        and c.actual_remaining is null
    ) then
    raise exception 'Báo cáo tồn thực tế chưa đầy đủ';
  end if;

  select
    v_round.opening_quantity - v_round.sold_quantity
      - coalesce(sum(coalesce(c.actual_remaining,0) + c.defective_quantity)
          filter (where c.cancellation_status = 'approved'),0),
    coalesce(sum(coalesce(c.actual_remaining,0) + c.defective_quantity)
          filter (where c.cancellation_status <> 'approved'),0)
  into v_expected, v_reported
  from public.ticket_round_codes c
  where c.round_id = p_round_id;

  v_variance := v_expected - v_reported;
  if v_variance = 0 then raise exception 'Vòng vé đã khớp, không cần xác nhận sai lệch'; end if;

  for v_code in
    select c.ticket_inventory_id, c.actual_remaining, c.defective_quantity
    from public.ticket_round_codes c
    where c.round_id = p_round_id and c.cancellation_status <> 'approved'
    order by c.slot
  loop
    update public.ticket_inventory i
    set handover_quantity = v_code.actual_remaining,
        status = case
          when v_code.actual_remaining = 0 then 'depleted'
          when v_code.actual_remaining < 5 then 'cancel_proposed'
          else 'active'
        end,
        cancelled_by = null,
        cancelled_at = null,
        updated_at = now()
    where i.id = v_code.ticket_inventory_id
      and i.business_id = v_round.business_id
      and i.venue_id = v_venue_id;

    if not found then raise exception 'Mã vé không thuộc đúng kho của sân khấu'; end if;
    v_inventory_ids := array_append(v_inventory_ids, v_code.ticket_inventory_id);
  end loop;

  update public.ticket_rounds
  set reconciliation_confirmed_at = now(),
      reconciliation_confirmed_by = v_user,
      reconciliation_variance = v_variance,
      updated_by = v_user,
      updated_at = now()
  where id = p_round_id;

  return jsonb_build_object(
    'round_id', p_round_id,
    'venue_id', v_venue_id,
    'variance', v_variance,
    'expected', v_expected,
    'reported', v_reported,
    'inventory_ids', to_jsonb(v_inventory_ids),
    'confirmed_at', now()
  );
end
$function$;

create or replace function public.confirm_ticket_reconciliation(p_round_id bigint)
returns jsonb
language sql
set search_path to ''
as $function$
  select private.confirm_ticket_reconciliation(p_round_id)
$function$;

revoke all on function private.confirm_ticket_reconciliation(bigint) from public, anon;
revoke all on function public.confirm_ticket_reconciliation(bigint) from public, anon;
grant execute on function private.confirm_ticket_reconciliation(bigint) to authenticated, service_role;
grant execute on function public.confirm_ticket_reconciliation(bigint) to authenticated, service_role;