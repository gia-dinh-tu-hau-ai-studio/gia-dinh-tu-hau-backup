-- NLH chỉ có giá 40.000đ/vé tại Sân Khấu Lộc Ninh (venue_id = 3).
-- Các sân khấu còn lại tiếp tục dùng giá 30.000đ/vé.

alter table public.game_shift_reports
  drop column total_amount;

alter table public.game_shift_reports
  add column total_amount numeric generated always as (
    ticket_10k_quantity::numeric * 10000::numeric
    + ticket_20k_quantity::numeric * 20000::numeric
    + inflatable_20k_quantity::numeric * 20000::numeric
    + nlh_30k_quantity::numeric
      * case when venue_id = 3 then 40000::numeric else 30000::numeric end
  ) stored;

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
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_shift public.shifts%rowtype;
  v_report_id bigint;
  v_finance_id bigint;
  v_total numeric;
  v_report_date date;
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

  v_total :=
    p_ticket_10k * 10000::numeric
    + p_ticket_20k * 20000::numeric
    + p_inflatable_20k * 20000::numeric
    + p_nlh_30k
      * case when v_shift.venue_id = 3 then 40000::numeric else 30000::numeric end;

  insert into public.game_shift_reports (
    business_id,venue_id,shift_id,report_date,
    ticket_10k_quantity,ticket_20k_quantity,inflatable_20k_quantity,nlh_30k_quantity,
    created_by,updated_by
  ) values (
    v_shift.business_id,v_shift.venue_id,v_shift.id,v_report_date,
    p_ticket_10k,p_ticket_20k,p_inflatable_20k,p_nlh_30k,
    (select auth.uid()),(select auth.uid())
  )
  on conflict (shift_id) do update set
    report_date = excluded.report_date,
    ticket_10k_quantity = excluded.ticket_10k_quantity,
    ticket_20k_quantity = excluded.ticket_20k_quantity,
    inflatable_20k_quantity = excluded.inflatable_20k_quantity,
    nlh_30k_quantity = excluded.nlh_30k_quantity,
    updated_by = (select auth.uid()),
    updated_at = now()
  returning id into v_report_id;

  insert into public.finance_entries (
    client_id,business_id,venue_id,shift_id,entry_date,entry_type,category,
    amount,note,status,created_by
  ) values (
    'game-shift-' || v_shift.id::text,
    v_shift.business_id,v_shift.venue_id,v_shift.id,v_report_date,
    'revenue','game',v_total,'Tự động từ Báo Cáo Trò Chơi','approved',(select auth.uid())
  )
  on conflict (client_id) do update set
    amount = excluded.amount,
    entry_date = excluded.entry_date,
    note = excluded.note,
    updated_at = now()
  returning id into v_finance_id;

  return query select v_report_id,v_finance_id,v_total;
end;
$function$;
