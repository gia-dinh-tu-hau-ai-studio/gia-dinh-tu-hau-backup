-- Nhân sự bộ phận Loto được xem lịch của tất cả nhân sự Loto,
-- tại mọi sân khấu trong cùng doanh nghiệp. Quyền thêm/sửa/xóa vẫn
-- chỉ thuộc Chủ sở hữu và Quản lý theo các chính sách riêng.
drop policy if exists weekly_staff_schedules_read on public.weekly_staff_schedules;

create policy weekly_staff_schedules_read
on public.weekly_staff_schedules
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.user_id = (select auth.uid())
      and p.business_id = weekly_staff_schedules.business_id
      and (
        p.role in ('owner', 'manager')
        or p.employee_id = weekly_staff_schedules.employee_id
        or exists (
          select 1
          from public.employees viewer
          where viewer.id = p.employee_id
            and viewer.business_id = weekly_staff_schedules.business_id
            and viewer.department = 'loto'
            and viewer.is_active is not false
        )
      )
  )
);
