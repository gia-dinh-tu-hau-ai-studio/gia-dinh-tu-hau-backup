-- Nhân sự chỉ được đọc điểm của chính mình.
-- Chỉ chủ sở hữu và quản lý đúng sân khấu được ghi điểm thi đua.

alter table public.staff_monthly_scores enable row level security;

drop policy if exists staff_monthly_scores_insert_scoped on public.staff_monthly_scores;
drop policy if exists staff_monthly_scores_update_scoped on public.staff_monthly_scores;

create policy staff_monthly_scores_insert_scoped
on public.staff_monthly_scores
for insert
to authenticated
with check (
  business_id = private.current_business_id()
  and exists (
    select 1
    from public.profiles p
    where p.user_id = (select auth.uid())
      and p.business_id = staff_monthly_scores.business_id
      and p.status = 'active'
      and (
        p.role = 'owner'
        or (
          p.role = 'manager'
          and exists (
            select 1
            from public.employees e
            where e.id = staff_monthly_scores.employee_id
              and e.business_id = p.business_id
              and e.account_venue_id = p.venue_id
          )
        )
      )
  )
);

create policy staff_monthly_scores_update_scoped
on public.staff_monthly_scores
for update
to authenticated
using (
  business_id = private.current_business_id()
  and exists (
    select 1
    from public.profiles p
    where p.user_id = (select auth.uid())
      and p.business_id = staff_monthly_scores.business_id
      and p.status = 'active'
      and (
        p.role = 'owner'
        or (
          p.role = 'manager'
          and exists (
            select 1
            from public.employees e
            where e.id = staff_monthly_scores.employee_id
              and e.business_id = p.business_id
              and e.account_venue_id = p.venue_id
          )
        )
      )
  )
)
with check (
  business_id = private.current_business_id()
  and exists (
    select 1
    from public.profiles p
    where p.user_id = (select auth.uid())
      and p.business_id = staff_monthly_scores.business_id
      and p.status = 'active'
      and (
        p.role = 'owner'
        or (
          p.role = 'manager'
          and exists (
            select 1
            from public.employees e
            where e.id = staff_monthly_scores.employee_id
              and e.business_id = p.business_id
              and e.account_venue_id = p.venue_id
          )
        )
      )
  )
);
