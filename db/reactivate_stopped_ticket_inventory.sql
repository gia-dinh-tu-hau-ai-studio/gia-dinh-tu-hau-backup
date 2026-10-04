-- Cho phép nhập lại mã vé đã ngừng sử dụng trong đúng kho sân khấu.
-- Không xóa vật lý bản ghi để bảo toàn lịch sử các vòng và báo cáo vé cũ.

create or replace function public.add_ticket_inventory_batch(
  p_venue_id bigint,
  p_items jsonb
) returns table(ticket_inventory_id bigint, code text, handover_quantity integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  b bigint;
  item jsonb;
  c text;
  q integer;
  inventory_id bigint;
  existing_status text;
begin
  b := private.current_business_id();
  if private.current_role() not in ('owner','manager') then
    raise exception 'Không có quyền nhập kho vé.';
  end if;
  if not private.can_access_venue(p_venue_id)
     or not exists (
       select 1 from public.venues v
       where v.id=p_venue_id and v.business_id=b and v.is_active
     ) then
    raise exception 'Không có quyền nhập kho cho sân khấu này.';
  end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then
    raise exception 'Phải nhập ít nhất một mã vé.';
  end if;
  if exists (
    select 1 from (
      select trim(value->>'code') c,count(*) n
      from jsonb_array_elements(p_items)
      group by trim(value->>'code')
    ) d where d.c<>'' and d.n>1
  ) then
    raise exception 'Danh sách đang có mã vé nhập trùng.';
  end if;

  for item in select value from jsonb_array_elements(p_items) loop
    c:=trim(coalesce(item->>'code',''));
    q:=coalesce((item->>'handover_quantity')::integer,0);
    if c='' or c!~'^[0-9]+$' then
      raise exception 'Mã vé chỉ được chứa chữ số.';
    end if;
    if q<=0 then
      raise exception 'Số lượng bàn giao phải lớn hơn 0.';
    end if;

    inventory_id:=null;
    existing_status:=null;
    select t.id,t.status into inventory_id,existing_status
    from public.ticket_inventory t
    where t.business_id=b and t.venue_id=p_venue_id and t.code=c
    for update;

    if inventory_id is not null and existing_status='active' then
      raise exception 'Mã vé % đã tồn tại trong kho sân khấu này, không được nhập trùng.',c;
    elsif inventory_id is not null then
      update public.ticket_inventory t
      set handover_quantity=q,
          gift_value=0,
          status='active',
          updated_at=now()
      where t.id=inventory_id;
    else
      insert into public.ticket_inventory
        (business_id,venue_id,code,handover_quantity,gift_value,status)
      values (b,p_venue_id,c,q,0,'active')
      returning id into inventory_id;
    end if;

    ticket_inventory_id:=inventory_id;
    code:=c;
    handover_quantity:=q;
    return next;
  end loop;
end;
$$;

revoke all on function public.add_ticket_inventory_batch(bigint,jsonb)
  from public, anon;
grant execute on function public.add_ticket_inventory_batch(bigint,jsonb)
  to authenticated;
