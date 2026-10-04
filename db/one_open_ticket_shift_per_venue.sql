-- Prevent concurrent File Vé sessions for the same business and stage.
create unique index if not exists shifts_one_open_per_business_venue
  on public.shifts (business_id, venue_id)
  where status = 'open';
