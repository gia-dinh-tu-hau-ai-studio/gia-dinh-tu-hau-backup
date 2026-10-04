-- A verified round with no variance is no longer reserved for a later shift.
-- Verified rounds that still have a non-zero variance remain locked until confirmed.
create or replace function public.save_ticket_round(p_client_id text, p_shift_id bigint, p_sequence_no integer, p_ticket_price numeric, p_opening_quantity integer, p_sold_quantity integer, p_gift_value numeric, p_codes jsonb, p_sales jsonb)
returns bigint
language plpgsql
set search_path to ''
as $function$
declare v_round_id bigint; v_business_id bigint; v_shift_status text; v_venue_id bigint;
begin
  select s.business_id,s.status,s.venue_id into v_business_id,v_shift_status,v_venue_id from public.shifts s where s.id=p_shift_id;
  if v_business_id is null then raise exception 'Shift not found'; end if;
  if v_shift_status<>'open' then raise exception 'Closed shift cannot be edited'; end if;
  if not exists(select 1 from public.venue_ticket_sources x where x.venue_id=v_venue_id and x.business_id=v_business_id and x.is_active) then raise exception 'Venue ticket source is not configured'; end if;
  if exists(select 1 from public.ticket_rounds r where r.client_id=p_client_id and r.status='verified') then raise exception 'Verified round cannot be edited'; end if;
  if exists(select 1 from jsonb_to_recordset(coalesce(p_codes,'[]'::jsonb)) x(slot smallint,ticket_inventory_id bigint) left join public.ticket_inventory i on i.id=x.ticket_inventory_id where i.id is null or i.business_id<>v_business_id or i.venue_id<>v_venue_id or i.status<>'active' or i.handover_quantity<5) then raise exception 'Ticket code is invalid, locked, or below minimum'; end if;
  if exists(select 1 from jsonb_to_recordset(coalesce(p_codes,'[]'::jsonb)) x(slot smallint,ticket_inventory_id bigint) join public.ticket_round_codes c on c.ticket_inventory_id=x.ticket_inventory_id join public.ticket_rounds r on r.id=c.round_id where r.shift_id<>p_shift_id and (r.status<>'verified' or (r.reconciliation_confirmed_at is null and coalesce(r.reconciliation_variance,0)<>0))) then raise exception 'Ticket code is pending reconciliation from a previous shift'; end if;
  insert into public.ticket_rounds(client_id,business_id,shift_id,sequence_no,ticket_price,opening_quantity,sold_quantity,gift_value,gross_amount,net_amount,created_by,updated_by) values(p_client_id,v_business_id,p_shift_id,p_sequence_no,p_ticket_price,p_opening_quantity,p_sold_quantity,p_gift_value,p_sold_quantity*p_ticket_price,(p_sold_quantity*p_ticket_price)-p_gift_value,(select auth.uid()),(select auth.uid())) on conflict(client_id) do update set sequence_no=excluded.sequence_no,ticket_price=excluded.ticket_price,opening_quantity=excluded.opening_quantity,sold_quantity=excluded.sold_quantity,gift_value=excluded.gift_value,gross_amount=excluded.gross_amount,net_amount=excluded.net_amount,updated_by=(select auth.uid()),updated_at=now() returning id into v_round_id;
  delete from public.ticket_round_codes c where c.round_id=v_round_id and not exists(select 1 from jsonb_to_recordset(coalesce(p_codes,'[]'::jsonb)) x(slot smallint,ticket_inventory_id bigint) where x.slot=c.slot);
  insert into public.ticket_round_codes(round_id,ticket_inventory_id,slot) select v_round_id,x.ticket_inventory_id,x.slot from jsonb_to_recordset(coalesce(p_codes,'[]'::jsonb)) x(slot smallint,ticket_inventory_id bigint) on conflict(round_id,slot) do update set ticket_inventory_id=excluded.ticket_inventory_id;
  delete from public.ticket_sales s where s.round_id=v_round_id and not exists(select 1 from jsonb_to_recordset(coalesce(p_sales,'[]'::jsonb)) x(employee_id bigint,quantity integer) where x.employee_id=s.employee_id);
  insert into public.ticket_sales(round_id,employee_id,quantity,amount,updated_by) select v_round_id,x.employee_id,x.quantity,x.quantity*p_ticket_price,(select auth.uid()) from jsonb_to_recordset(coalesce(p_sales,'[]'::jsonb)) x(employee_id bigint,quantity integer) on conflict(round_id,employee_id) do update set quantity=excluded.quantity,amount=excluded.amount,updated_by=(select auth.uid()),updated_at=now();
  return v_round_id;
end;
$function$;
