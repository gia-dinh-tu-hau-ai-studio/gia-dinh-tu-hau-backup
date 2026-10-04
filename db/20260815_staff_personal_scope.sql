-- Nhân viên thường chỉ được đọc hồ sơ và lịch của chính mình.
-- Quản lý/chủ sở hữu giữ phạm vi quản trị; dữ liệu tài chính của quản lý
-- tiếp tục bị giới hạn bởi private.can_access_venue(venue_id).

drop policy if exists employees_personal_scope on public.employees;
create policy employees_personal_scope
on public.employees
as restrictive
for select
to authenticated
using (
  private.current_role() in ('owner', 'manager')
  or id = (
    select p.employee_id
    from public.profiles p
    where p.user_id = (select auth.uid())
      and p.status = 'active'
    limit 1
  )
);

drop policy if exists manager_venue_scope on public.weekly_staff_schedules;
create policy manager_venue_scope
on public.weekly_staff_schedules
as restrictive
for all
to authenticated
using (
  private.current_role() = 'owner'
  or (private.current_role() = 'manager' and private.can_access_venue(venue_id))
  or employee_id = (
    select p.employee_id
    from public.profiles p
    where p.user_id = (select auth.uid())
      and p.status = 'active'
    limit 1
  )
)
with check (
  private.current_role() = 'owner'
  or (private.current_role() = 'manager' and private.can_access_venue(venue_id))
);

-- Thu/chi không bao giờ được mở cho vai trò nhân viên thường.
drop policy if exists finance_management_only on public.finance_entries;
create policy finance_management_only
on public.finance_entries
as restrictive
for all
to authenticated
using (private.current_role() in ('owner', 'manager'))
with check (private.current_role() in ('owner', 'manager'));

-- Thu hẹp tài khoản nhân viên đã tồn tại về đúng phân hệ nhân sự cá nhân.
update public.profiles
set allowed_modules = array['employees']::text[],
    access_level = 3
where role = 'employee';
