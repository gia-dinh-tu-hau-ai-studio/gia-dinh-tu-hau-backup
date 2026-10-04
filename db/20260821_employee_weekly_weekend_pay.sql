alter table public.employees
  add column if not exists weekly_payment_weekday smallint not null default 4
    check (weekly_payment_weekday between 1 and 7),
  add column if not exists weekend_hourly_rate numeric not null default 0
    check (weekend_hourly_rate >= 0);

comment on column public.employees.weekly_payment_weekday is
  'ISO weekday used to pay weekly employees: 1=Monday ... 7=Sunday';
comment on column public.employees.weekend_hourly_rate is
  'Separate Saturday/Sunday rate for hourly and weekly employees';