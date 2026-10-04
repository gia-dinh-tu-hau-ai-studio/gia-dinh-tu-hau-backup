-- Doanh thu Trò Chơi được nhập theo số lượng của từng loại vé.
-- Khi sửa một báo cáo đã có, kho chỉ thay đổi theo phần chênh lệch để tránh
-- trừ lặp. Toàn bộ thao tác nằm trong cùng transaction của RPC.

alter table public.game_ticket_inventory_transactions
  drop constraint if exists game_ticket_inventory_transactions_transaction_type_check;

alter table public.game_ticket_inventory_transactions
  add constraint game_ticket_inventory_transactions_transaction_type_check
  check (transaction_type in ('stock_in','stock_count','stock_out'));

create or replace function public.save_game_shift_report(
  p_shift_id bigint,
  p_report_date date,
  p_ticket_10k integer,
  p_ticket_20k integer,
  p_inflatable_20k integer,
  p_nlh_30k integer
)
returns table(report_id bigint, finance_entry_id bigint, total_amount numeric)
language plpgsql
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_shift public.shifts%rowtype;
  v_old public.game_shift_reports%rowtype;
  v_report_id bigint;
  v_finance_id bigint;
  v_total numeric;
  v_report_date date;
  v_item record;
  v_before integer;
  v_after integer;
begin
  if least(p_ticket_10k,p_ticket_20k,p_inflatable_20k,p_nlh_30k) < 0 then
    raise exception 'Số lượng vé không được âm';
  end if;

  v_report_date := coalesce(p_report_date, current_date);
  if v_report_date > current_date or v_report_date < current_date - 30 then
    raise exception 'Ngày làm việc chỉ được chọn từ hôm nay hoặc 30 ngày trước';
  end if;

  select * into v_shift
  from public.shifts
  where id = p_shift_id
    and business_id = private.current_business_id()
    and status = 'open';

  if not found then
    raise exception 'Ca làm việc không tồn tại hoặc đã đóng';
  end if;

  select * into v_old
  from public.game_shift_reports
  where shift_id = v_shift.id
  for update;

  for v_item in
    select * from (values
      ('ticket_10k', p_ticket_10k, coalesce(v_old.ticket_10k_quantity,0)),
      ('ticket_20k', p_ticket_20k, coalesce(v_old.ticket_20k_quantity,0)),
      ('inflatable_20k', p_inflatable_20k, coalesce(v_old.inflatable_20k_quantity,0)),
      ('nlh_30k', p_nlh_30k, coalesce(v_old.nlh_30k_quantity,0))
    ) as items(product_key,new_quantity,old_quantity)
  loop
    if v_item.new_quantity = v_item.old_quantity then
      continue;
    end if;

    insert into public.game_ticket_inventory
      (business_id,venue_id,product_key,quantity_on_hand)
    values
      (v_shift.business_id,v_shift.venue_id,v_item.product_key,0)
    on conflict (business_id,venue_id,product_key) do nothing;

    select quantity_on_hand into v_before
    from public.game_ticket_inventory
    where business_id=v_shift.business_id
      and venue_id=v_shift.venue_id
      and product_key=v_item.product_key
    for update;

    v_after := v_before - (v_item.new_quantity-v_item.old_quantity);
    if v_after < 0 then
      raise exception 'Tồn kho % chỉ còn %, không đủ ghi nhận % vé bán',
        v_item.product_key, v_before, v_item.new_quantity-v_item.old_quantity;
    end if;

    update public.game_ticket_inventory
    set quantity_on_hand=v_after,updated_at=now()
    where business_id=v_shift.business_id
      and venue_id=v_shift.venue_id
      and product_key=v_item.product_key;

    insert into public.game_ticket_inventory_transactions
      (business_id,venue_id,product_key,transaction_type,quantity_change,
       quantity_before,quantity_after,note)
    values
      (v_shift.business_id,v_shift.venue_id,v_item.product_key,'stock_out',
       -(v_item.new_quantity-v_item.old_quantity),v_before,v_after,
       'Bán vé Trò Chơi · ca '||v_shift.id::text||' · '||v_report_date::text);
  end loop;

  v_total :=
    p_ticket_10k * 10000::numeric
    + p_ticket_20k * 20000::numeric
    + p_inflatable_20k * 20000::numeric
    + p_nlh_30k * case when v_shift.venue_id=3 then 40000::numeric else 30000::numeric end;

  insert into public.game_shift_reports (
    business_id,venue_id,shift_id,report_date,
    ticket_10k_quantity,ticket_20k_quantity,inflatable_20k_quantity,nlh_30k_quantity,
    created_by,updated_by
  ) values (
    v_shift.business_id,v_shift.venue_id,v_shift.id,v_report_date,
    p_ticket_10k,p_ticket_20k,p_inflatable_20k,p_nlh_30k,
    auth.uid(),auth.uid()
  )
  on conflict (shift_id) do update set
    report_date=excluded.report_date,
    ticket_10k_quantity=excluded.ticket_10k_quantity,
    ticket_20k_quantity=excluded.ticket_20k_quantity,
    inflatable_20k_quantity=excluded.inflatable_20k_quantity,
    nlh_30k_quantity=excluded.nlh_30k_quantity,
    updated_by=auth.uid(),updated_at=now()
  returning id into v_report_id;

  insert into public.finance_entries (
    client_id,business_id,venue_id,shift_id,entry_date,entry_type,category,
    amount,note,status,created_by
  ) values (
    'game-shift-'||v_shift.id::text,v_shift.business_id,v_shift.venue_id,
    v_shift.id,v_report_date,'revenue','game',v_total,
    'Tự động từ số lượng vé Trò Chơi đã bán','approved',auth.uid()
  )
  on conflict (client_id) do update set
    amount=excluded.amount,entry_date=excluded.entry_date,note=excluded.note,updated_at=now()
  returning id into v_finance_id;

  return query select v_report_id,v_finance_id,v_total;
end;
$function$;

revoke all on function public.save_game_shift_report(bigint,date,integer,integer,integer,integer) from public,anon;
grant execute on function public.save_game_shift_report(bigint,date,integer,integer,integer,integer) to authenticated;
