-- One File Vé per business, stage and work date.
-- Existing historical duplicates are preserved; the rule applies to all new writes.

create or replace function public.enforce_one_ticket_shift_per_work_date()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Serialize attempts for the same business/stage so concurrent users cannot
  -- both pass the existence check before either insert commits.
  -- PostgreSQL only supports pg_advisory_xact_lock(bigint) or
  -- pg_advisory_xact_lock(integer, integer). Hash the two bigint identifiers
  -- into one stable bigint lock key so large IDs remain supported.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.business_id::text || ':' || new.venue_id::text, 0)
  );

  if exists (
    select 1
    from public.shifts s
    where s.business_id = new.business_id
      and s.venue_id = new.venue_id
      and s.performance_date = new.performance_date
      and s.id <> coalesce(new.id, 0)
  ) then
    raise exception using
      errcode = '23505',
      message = 'Sân khấu này đã có File Vé trong ngày làm việc đã chọn. Hãy mở lại đúng phiên đã có.';
  end if;

  return new;
end;
$$;

drop trigger if exists shifts_one_per_work_date on public.shifts;
create trigger shifts_one_per_work_date
before insert or update of business_id, venue_id, performance_date
on public.shifts
for each row execute function public.enforce_one_ticket_shift_per_work_date();

-- A database-level uniqueness guarantee for all current and future dates.
-- The cutoff preserves the duplicate historical rows from 13/08/2026 without
-- deleting or merging any real ticket data.
create unique index if not exists shifts_one_per_work_date_from_20260814
  on public.shifts (business_id, venue_id, performance_date)
  where performance_date >= date '2026-08-14';
