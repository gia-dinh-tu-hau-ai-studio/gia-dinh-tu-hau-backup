-- Only owner accounts (including the Admin account) may manually change ticket stock.
-- Managers keep read access and operational reporting continues through its existing RPCs.

drop policy if exists inventory_insert on public.ticket_inventory;
create policy inventory_insert
on public.ticket_inventory
for insert
to authenticated
with check (
  business_id = private.current_business_id()
  and private.current_role() = 'owner'
);

drop policy if exists inventory_update on public.ticket_inventory;
create policy inventory_update
on public.ticket_inventory
for update
to authenticated
using (
  business_id = private.current_business_id()
  and private.current_role() = 'owner'
)
with check (
  business_id = private.current_business_id()
  and private.current_role() = 'owner'
);

drop policy if exists inventory_delete on public.ticket_inventory;
create policy inventory_delete
on public.ticket_inventory
for delete
to authenticated
using (
  business_id = private.current_business_id()
  and private.current_role() = 'owner'
);

drop policy if exists game_ticket_inventory_write on public.game_ticket_inventory;
create policy game_ticket_inventory_write
on public.game_ticket_inventory
for all
to authenticated
using (
  business_id = private.current_business_id()
  and private.can_access_venue(venue_id)
  and private.current_role() = 'owner'
)
with check (
  business_id = private.current_business_id()
  and private.can_access_venue(venue_id)
  and private.current_role() = 'owner'
);

drop policy if exists game_ticket_inventory_transactions_insert on public.game_ticket_inventory_transactions;
create policy game_ticket_inventory_transactions_insert
on public.game_ticket_inventory_transactions
for insert
to authenticated
with check (
  business_id = private.current_business_id()
  and private.can_access_venue(venue_id)
  and private.current_role() = 'owner'
);
