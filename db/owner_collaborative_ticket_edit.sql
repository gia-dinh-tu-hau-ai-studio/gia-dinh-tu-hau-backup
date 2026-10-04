-- Chủ sở hữu được chỉnh sửa trực tiếp ca đang do quản lý phụ trách.
-- Không đổi opened_by: quản lý vẫn là người phụ trách ca và không bị cướp quyền.
drop policy if exists ticket_shift_drafts_write on public.ticket_shift_drafts;
create policy ticket_shift_drafts_write on public.ticket_shift_drafts
for all to authenticated
using (
  business_id = private.current_business_id()
  and private.can_access_venue(venue_id)
  and exists (
    select 1 from public.shifts s
    where s.id = shift_id
      and s.business_id = ticket_shift_drafts.business_id
      and s.venue_id = ticket_shift_drafts.venue_id
      and s.status = 'open'
      and (s.opened_by = (select auth.uid()) or private.current_role() = 'owner')
  )
)
with check (
  business_id = private.current_business_id()
  and private.can_access_venue(venue_id)
  and exists (
    select 1 from public.shifts s
    where s.id = shift_id
      and s.business_id = ticket_shift_drafts.business_id
      and s.venue_id = ticket_shift_drafts.venue_id
      and s.status = 'open'
      and (s.opened_by = (select auth.uid()) or private.current_role() = 'owner')
  )
);
