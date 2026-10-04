-- Correct an already-deployed venue policy without modifying gift option rows.
-- Gift options are shared company configuration; ticket shifts remain venue-scoped.
begin;

drop policy if exists manager_venue_scope on public.gift_options;
drop policy if exists gift_options_company_scope on public.gift_options;

create policy gift_options_company_scope on public.gift_options
as restrictive for select to authenticated
using (business_id = private.current_business_id());

commit;
