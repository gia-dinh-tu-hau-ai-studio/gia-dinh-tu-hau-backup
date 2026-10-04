alter table public.employees
  add column if not exists daily_weekend_rate numeric not null default 0,
  add column if not exists daily_holiday_rate numeric not null default 0;

comment on column public.employees.daily_weekend_rate is 'Daily salary rate for Saturday and Sunday';
comment on column public.employees.daily_holiday_rate is 'Daily salary rate for public holidays';