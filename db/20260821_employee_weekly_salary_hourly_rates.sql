alter table public.employees
  add column if not exists weekly_salary numeric not null default 0,
  add column if not exists holiday_hourly_rate numeric not null default 0;

comment on column public.employees.weekly_salary is 'Mức lương trọn tuần; chốt Chủ Nhật và nhận vào Thứ Tư.';
comment on column public.employees.holiday_hourly_rate is 'Đơn giá lương theo giờ áp dụng ngày lễ.';
