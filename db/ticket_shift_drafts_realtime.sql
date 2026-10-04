-- Phát bản nháp File Vé theo thời gian thực cho các tài khoản chỉ đang xem.
-- Bản ghi vẫn được giới hạn bởi RLS, business_id, venue_id và shift_id.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime'
      and schemaname='public'
      and tablename='ticket_shift_drafts'
  ) then
    alter publication supabase_realtime add table public.ticket_shift_drafts;
  end if;
end;
$$;
