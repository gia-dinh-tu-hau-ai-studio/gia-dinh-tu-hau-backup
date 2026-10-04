-- Sân Khấu Gò An Lạc: thưởng theo từng đêm diễn.
-- Chỉ ghi khi doanh thu Loto vượt 10.000.000 đ; ba nhân sự nhận 4% mỗi người.
create table if not exists public.go_an_lac_night_rewards (
  id bigint generated always as identity primary key,
  business_id bigint not null references public.businesses(id) on delete cascade,
  venue_id bigint not null references public.venues(id) on delete cascade,
  performance_date date not null,
  employee_id bigint not null references public.employees(id) on delete restrict,
  revenue_amount numeric(14,2) not null check (revenue_amount >= 0),
  reward_rate numeric(5,4) not null default 0.04 check (reward_rate = 0.04),
  reward_amount numeric(14,2) not null check (reward_amount >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, venue_id, performance_date, employee_id)
);

create index if not exists go_an_lac_night_rewards_lookup_idx
  on public.go_an_lac_night_rewards (business_id, employee_id, performance_date);

alter table public.go_an_lac_night_rewards enable row level security;

create policy go_an_lac_night_rewards_read on public.go_an_lac_night_rewards
  for select to authenticated using (
    exists (select 1 from public.profiles p where p.user_id = auth.uid()
      and p.business_id = go_an_lac_night_rewards.business_id
      and p.status = 'active' and private.can_access_venue(go_an_lac_night_rewards.venue_id))
  );

create policy go_an_lac_night_rewards_write on public.go_an_lac_night_rewards
  for all to authenticated using (
    exists (select 1 from public.profiles p where p.user_id = auth.uid()
      and p.business_id = go_an_lac_night_rewards.business_id and p.status = 'active'
      and p.role in ('owner','manager') and private.can_access_venue(go_an_lac_night_rewards.venue_id))
  ) with check (
    exists (select 1 from public.profiles p where p.user_id = auth.uid()
      and p.business_id = go_an_lac_night_rewards.business_id and p.status = 'active'
      and p.role in ('owner','manager') and private.can_access_venue(go_an_lac_night_rewards.venue_id))
  );
