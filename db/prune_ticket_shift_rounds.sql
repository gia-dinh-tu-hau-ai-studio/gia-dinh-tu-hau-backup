create or replace function public.prune_ticket_shift_rounds(
  p_shift_id bigint,
  p_active_client_ids jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted integer := 0;
  v_business_id bigint;
  v_status text;
  v_opened_by uuid;
begin
  select s.business_id,s.status,s.opened_by
  into v_business_id,v_status,v_opened_by
  from public.shifts s
  where s.id=p_shift_id;

  if v_business_id is null or v_business_id<>private.current_business_id() then
    raise exception 'Shift not found';
  end if;
  if v_status<>'open' then
    raise exception 'Closed shift cannot be edited';
  end if;
  if v_opened_by is distinct from (select auth.uid()) and private.current_role()<>'owner' then
    raise exception 'This ticket file is held by another account';
  end if;
  if jsonb_typeof(coalesce(p_active_client_ids,'[]'::jsonb))<>'array' then
    raise exception 'Active round list is invalid';
  end if;

  delete from public.ticket_rounds r
  where r.shift_id=p_shift_id
    and r.business_id=v_business_id
    and r.status<>'verified'
    and not exists (
      select 1
      from jsonb_array_elements_text(coalesce(p_active_client_ids,'[]'::jsonb)) active(client_id)
      where active.client_id=r.client_id
    );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.prune_ticket_shift_rounds(bigint,jsonb) from public;
revoke execute on function public.prune_ticket_shift_rounds(bigint,jsonb) from anon;
grant execute on function public.prune_ticket_shift_rounds(bigint,jsonb) to authenticated;