CREATE OR REPLACE FUNCTION public.get_ticket_inventory_alert_for_venue(p_venue_id bigint)
 RETURNS TABLE(venue_id bigint, available_codes bigint, source_configured boolean, stale_codes jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_business_id bigint:=private.current_business_id();
  v_user uuid:=(select auth.uid());
  v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles p
  where p.user_id=v_user and p.business_id=v_business_id and p.status='active';
  if v_profile.user_id is null then raise exception 'Tài khoản chưa được duyệt'; end if;
  if not exists(select 1 from public.venues v where v.id=p_venue_id and v.business_id=v_business_id and v.is_active)
    then raise exception 'Sân khấu không thuộc phạm vi công ty'; end if;
  if v_profile.role='manager' and v_profile.venue_id<>p_venue_id then
    raise exception 'Tài khoản không thuộc sân khấu này';
  elsif v_profile.role='employee' and not exists(
    select 1 from public.shifts s
    where s.business_id=v_business_id and s.venue_id=p_venue_id and s.status='open'
      and (s.opened_by=v_user or exists(
        select 1 from public.shift_staff ss where ss.shift_id=s.id and ss.employee_id=v_profile.employee_id
      ))
  ) then
    raise exception 'Tài khoản không có ca đang mở tại sân khấu này';
  end if;

  return query
  with inventory_usage as (
    select ti.id,ti.code,ti.handover_quantity,ti.created_at,
      max(s.performance_date) filter(where tr.sold_quantity>0) last_used_date,
      exists(
        select 1 from public.ticket_round_codes pc
        join public.ticket_rounds pr on pr.id=pc.round_id
        where pc.ticket_inventory_id=ti.id and pr.status<>'verified'
      ) pending_report
    from public.ticket_inventory ti
    left join public.ticket_round_codes trc on trc.ticket_inventory_id=ti.id
    left join public.ticket_rounds tr on tr.id=trc.round_id
    left join public.shifts s on s.id=tr.shift_id and s.venue_id=p_venue_id and s.business_id=v_business_id
    where ti.business_id=v_business_id and ti.venue_id=p_venue_id
      and ti.status='active' and ti.handover_quantity>=5
    group by ti.id
  )
  select p_venue_id,
    count(distinct regexp_replace(iu.code,'^0+(?=[0-9])','','g')) filter(where not iu.pending_report),
    exists(select 1 from public.venue_ticket_sources src where src.business_id=v_business_id and src.venue_id=p_venue_id and src.is_active),
    coalesce(jsonb_agg(jsonb_build_object(
      'code',iu.code,'quantity',iu.handover_quantity,'last_used_date',iu.last_used_date,
      'days_unused',(current_date-coalesce(iu.last_used_date,iu.created_at::date))
    ) order by (current_date-coalesce(iu.last_used_date,iu.created_at::date)) desc,iu.code)
      filter(where not iu.pending_report and current_date-coalesce(iu.last_used_date,iu.created_at::date)>=10),'[]'::jsonb)
  from inventory_usage iu;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_ticket_inventory_alerts()
 RETURNS TABLE(venue_id bigint, available_codes bigint, source_configured boolean, stale_codes jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_business_id bigint:=private.current_business_id();
  v_role text;
  v_manager_venue_id bigint;
begin
  select p.role,p.venue_id into v_role,v_manager_venue_id
  from public.profiles p
  where p.user_id=(select auth.uid()) and p.business_id=v_business_id and p.status='active';
  if v_business_id is null or v_role not in ('owner','manager') then
    raise exception 'Tài khoản không có quyền xem cảnh báo kho vé';
  end if;
  return query
  with inventory_usage as (
    select ti.id,ti.venue_id,ti.code,ti.handover_quantity,ti.created_at,
      max(s.performance_date) filter(where tr.sold_quantity>0) as last_used_date,
      exists(
        select 1 from public.ticket_round_codes pc
        join public.ticket_rounds pr on pr.id=pc.round_id
        where pc.ticket_inventory_id=ti.id and pr.status<>'verified'
      ) as pending_report
    from public.ticket_inventory ti
    left join public.ticket_round_codes trc on trc.ticket_inventory_id=ti.id
    left join public.ticket_rounds tr on tr.id=trc.round_id
    left join public.shifts s on s.id=tr.shift_id and s.venue_id=ti.venue_id and s.business_id=ti.business_id
    where ti.business_id=v_business_id and ti.status='active' and ti.handover_quantity>=5
    group by ti.id
  ), venue_summary as (
    select v.id venue_id,
      count(distinct regexp_replace(iu.code,'^0+(?=[0-9])','','g')) filter(where not iu.pending_report) available_codes,
      exists(select 1 from public.venue_ticket_sources src where src.business_id=v_business_id and src.venue_id=v.id and src.is_active) source_configured,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'code',iu.code,
            'quantity',iu.handover_quantity,
            'last_used_date',iu.last_used_date,
            'days_unused',(current_date-coalesce(iu.last_used_date,iu.created_at::date))
          )
          order by (current_date-coalesce(iu.last_used_date,iu.created_at::date)) desc,iu.code
        ) filter(
          where not iu.pending_report
            and current_date-coalesce(iu.last_used_date,iu.created_at::date)>=10
        ),
        '[]'::jsonb
      ) stale_codes
    from public.venues v
    left join inventory_usage iu on iu.venue_id=v.id
    where v.business_id=v_business_id and v.is_active
      and (v_role='owner' or v.id=v_manager_venue_id)
    group by v.id
  )
  select vs.venue_id,vs.available_codes,vs.source_configured,vs.stale_codes
  from venue_summary vs order by vs.venue_id;
end;
$function$;

revoke all on function public.get_ticket_inventory_alerts() from public;
grant execute on function public.get_ticket_inventory_alerts() to authenticated;
revoke all on function public.get_ticket_inventory_alert_for_venue(bigint) from public;
grant execute on function public.get_ticket_inventory_alert_for_venue(bigint) to authenticated;

