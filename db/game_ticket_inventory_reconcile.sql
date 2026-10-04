create or replace function public.reconcile_game_ticket_inventory(
  p_venue_id bigint,
  p_items jsonb,
  p_note text default null
)
returns setof public.game_ticket_inventory
language plpgsql
security invoker
set search_path = public, private
as $$
declare
  v_business_id bigint := private.current_business_id();
  v_item record;
  v_before integer;
  v_after integer;
begin
  if not private.can_access_venue(p_venue_id)
     or private.current_role() not in ('owner','manager')
     or not exists (
       select 1 from public.venues v
       where v.id=p_venue_id and v.business_id=v_business_id and v.is_active
     ) then
    raise exception 'Không có quyền kiểm kê kho cho sân khấu này';
  end if;

  for v_item in
    select x.product_key, x.actual_quantity
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(product_key text, actual_quantity integer)
    where x.actual_quantity >= 0
  loop
    if v_item.product_key not in ('ticket_10k','ticket_20k','inflatable_20k','nlh_30k') then
      raise exception 'Loại vé trò chơi không hợp lệ';
    end if;

    insert into public.game_ticket_inventory (business_id, venue_id, product_key, quantity_on_hand)
    values (v_business_id, p_venue_id, v_item.product_key, 0)
    on conflict (business_id, venue_id, product_key) do nothing;

    select quantity_on_hand into v_before
    from public.game_ticket_inventory
    where business_id = v_business_id and venue_id = p_venue_id and product_key = v_item.product_key
    for update;

    v_after := v_item.actual_quantity;
    update public.game_ticket_inventory
      set quantity_on_hand = v_after, updated_at = now()
      where business_id = v_business_id and venue_id = p_venue_id and product_key = v_item.product_key;

    insert into public.game_ticket_inventory_transactions
      (business_id, venue_id, product_key, transaction_type, quantity_change, quantity_before, quantity_after, note)
    values
      (v_business_id, p_venue_id, v_item.product_key, 'stock_count', v_after - v_before, v_before, v_after, nullif(trim(p_note),''));
  end loop;

  return query
    select * from public.game_ticket_inventory
    where business_id = v_business_id and venue_id = p_venue_id
    order by product_key;
end;
$$;

revoke all on function public.reconcile_game_ticket_inventory(bigint,jsonb,text) from public, anon;
grant execute on function public.reconcile_game_ticket_inventory(bigint,jsonb,text) to authenticated;
