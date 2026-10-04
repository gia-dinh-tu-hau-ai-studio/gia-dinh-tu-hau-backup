-- Save an entire ticket file atomically. Reordering rows can temporarily use
-- high sequence numbers, but an interrupted request now rolls back everything.
create or replace function public.save_ticket_shift_rows(p_shift_id bigint, p_rows jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_business_id bigint; v_shift_status text; v_venue_id bigint; v_row jsonb;
  v_round_id bigint; v_client_id text; v_sequence_no integer; v_codes jsonb;
  v_sales jsonb; v_saved integer := 0;
begin
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then raise exception 'Ticket rows are invalid'; end if;
  select s.business_id,s.status,s.venue_id into v_business_id,v_shift_status,v_venue_id from public.shifts s where s.id=p_shift_id;
  if v_business_id is null then raise exception 'Shift not found'; end if;
  if v_shift_status <> 'open' then raise exception 'Closed shift cannot be edited'; end if;
  if not exists(select 1 from public.venue_ticket_sources x where x.venue_id=v_venue_id and x.business_id=v_business_id and x.is_active) then raise exception 'Venue ticket source is not configured'; end if;
  if exists(select 1 from jsonb_array_elements(p_rows) row group by row->>'client_id' having count(*)>1) then raise exception 'Duplicate ticket row in this file'; end if;
  if exists(select 1 from jsonb_array_elements(p_rows) row,jsonb_to_recordset(coalesce(row->'codes','[]'::jsonb)) x(slot smallint,ticket_inventory_id bigint) group by x.ticket_inventory_id having count(*)>1) then raise exception 'A ticket code is duplicated in this file'; end if;

  -- All temporary order changes are inside this one database transaction.
  update public.ticket_rounds set sequence_no=1000000000+id where shift_id=p_shift_id and status<>'verified';

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_client_id:=coalesce(v_row->>'client_id',''); v_sequence_no:=(v_row->>'sequence_no')::integer;
    v_codes:=coalesce(v_row->'codes','[]'::jsonb); v_sales:=coalesce(v_row->'sales','[]'::jsonb);
    if v_client_id='' or v_sequence_no is null or v_sequence_no<1 then raise exception 'Ticket row is invalid'; end if;
    if exists(select 1 from public.ticket_rounds r where r.client_id=v_client_id and r.status='verified') then raise exception 'Verified round cannot be edited'; end if;
    if exists(select 1 from jsonb_to_recordset(v_codes) x(slot smallint,ticket_inventory_id bigint) left join public.ticket_inventory i on i.id=x.ticket_inventory_id where i.id is null or i.business_id<>v_business_id or i.venue_id<>v_venue_id or i.status<>'active' or i.handover_quantity<5) then raise exception 'Ticket code is invalid, locked, or below minimum'; end if;
    if exists(select 1 from jsonb_to_recordset(v_codes) x(slot smallint,ticket_inventory_id bigint) join public.ticket_round_codes c on c.ticket_inventory_id=x.ticket_inventory_id join public.ticket_rounds r on r.id=c.round_id where r.shift_id<>p_shift_id and (r.status<>'verified' or (r.reconciliation_confirmed_at is null and coalesce(r.reconciliation_variance,0)<>0))) then raise exception 'Ticket code is pending reconciliation from a previous shift'; end if;
    insert into public.ticket_rounds(client_id,business_id,shift_id,sequence_no,ticket_price,opening_quantity,sold_quantity,gift_value,gross_amount,net_amount,created_by,updated_by)
    values(v_client_id,v_business_id,p_shift_id,v_sequence_no,coalesce((v_row->>'ticket_price')::numeric,0),coalesce((v_row->>'opening_quantity')::integer,0),coalesce((v_row->>'sold_quantity')::integer,0),coalesce((v_row->>'gift_value')::numeric,0),coalesce((v_row->>'sold_quantity')::integer,0)*coalesce((v_row->>'ticket_price')::numeric,0),(coalesce((v_row->>'sold_quantity')::integer,0)*coalesce((v_row->>'ticket_price')::numeric,0))-coalesce((v_row->>'gift_value')::numeric,0),(select auth.uid()),(select auth.uid()))
    on conflict(client_id) do update set sequence_no=excluded.sequence_no,ticket_price=excluded.ticket_price,opening_quantity=excluded.opening_quantity,sold_quantity=excluded.sold_quantity,gift_value=excluded.gift_value,gross_amount=excluded.gross_amount,net_amount=excluded.net_amount,updated_by=(select auth.uid()),updated_at=now()
    returning id into v_round_id;
    delete from public.ticket_round_codes where round_id=v_round_id;
    insert into public.ticket_round_codes(round_id,ticket_inventory_id,slot) select v_round_id,x.ticket_inventory_id,x.slot from jsonb_to_recordset(v_codes) x(slot smallint,ticket_inventory_id bigint);
    delete from public.ticket_sales s where s.round_id=v_round_id and not exists(select 1 from jsonb_to_recordset(v_sales) x(employee_id bigint,quantity integer) where x.employee_id=s.employee_id);
    insert into public.ticket_sales(round_id,employee_id,quantity,amount,updated_by) select v_round_id,x.employee_id,x.quantity,x.quantity*coalesce((v_row->>'ticket_price')::numeric,0),(select auth.uid()) from jsonb_to_recordset(v_sales) x(employee_id bigint,quantity integer) on conflict(round_id,employee_id) do update set quantity=excluded.quantity,amount=excluded.amount,updated_by=(select auth.uid()),updated_at=now();
    v_saved:=v_saved+1;
  end loop;
  delete from public.ticket_rounds r where r.shift_id=p_shift_id and r.business_id=v_business_id and r.status<>'verified' and not exists(select 1 from jsonb_array_elements(p_rows) row where row->>'client_id'=r.client_id);
  return v_saved;
end;
$$;
