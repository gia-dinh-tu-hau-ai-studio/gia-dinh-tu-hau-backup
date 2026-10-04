-- Nhân viên chỉ được xem thưởng đặc biệt của chính mình.
drop policy if exists go_an_lac_night_rewards_read on public.go_an_lac_night_rewards;

create policy go_an_lac_night_rewards_read on public.go_an_lac_night_rewards
  for select to authenticated using (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.business_id = go_an_lac_night_rewards.business_id
        and p.status = 'active'
        and (
          p.role = 'owner'
          or (p.role = 'manager' and private.can_access_venue(go_an_lac_night_rewards.venue_id))
          or (p.role not in ('owner','manager') and p.employee_id = go_an_lac_night_rewards.employee_id)
        )
    )
  );
