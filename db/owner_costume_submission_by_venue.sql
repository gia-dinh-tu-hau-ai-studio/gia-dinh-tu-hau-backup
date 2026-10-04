alter table public.costume_submissions
  add column if not exists venue_id bigint references public.venues(id) on delete restrict;

create index if not exists costume_submissions_venue_date_idx
  on public.costume_submissions(business_id,venue_id,submission_date desc);
create index if not exists costume_submissions_venue_id_idx
  on public.costume_submissions(venue_id);

drop function if exists public.add_costume_submission(bigint,date,text,integer,text,text);

create function public.add_costume_submission(
  p_employee_id bigint,
  p_submission_date date,
  p_costume_type text,
  p_quantity integer default 1,
  p_note text default null,
  p_photo_path text default null,
  p_venue_id bigint default null
)
returns bigint
language plpgsql
set search_path to ''
as $function$
declare
  v_business_id bigint:=private.current_business_id();
  v_employee_id bigint:=private.current_employee_id();
  v_role text:=private.current_role();
  v_submission_id bigint;
  v_month date:=date_trunc('month',p_submission_date)::date;
begin
  if v_business_id is null then raise exception 'Tài khoản chưa thuộc đơn vị.'; end if;
  if p_costume_type not in ('ao_dai','dress','ba_ba') or p_quantity<=0 then raise exception 'Dữ liệu trang phục không hợp lệ.'; end if;
  if v_role<>'owner' and v_employee_id is distinct from p_employee_id then
    raise exception 'Bạn không có quyền gửi ảnh thay nhân sự khác.';
  end if;
  if not exists(select 1 from public.employees e where e.id=p_employee_id and e.business_id=v_business_id and e.department='loto' and e.is_active) then
    raise exception 'Nhân sự Loto không tồn tại hoặc đã ngưng hoạt động.';
  end if;
  if p_venue_id is not null and not exists(select 1 from public.venues v where v.id=p_venue_id and v.business_id=v_business_id) then
    raise exception 'Sân khấu không thuộc đơn vị hiện tại.';
  end if;

  insert into public.costume_submissions(business_id,employee_id,venue_id,submission_date,costume_type,quantity,photo_path,note,submitted_by)
  values(v_business_id,p_employee_id,p_venue_id,p_submission_date,p_costume_type,p_quantity,p_photo_path,p_note,(select auth.uid()))
  returning id into v_submission_id;

  insert into public.costume_monthly_scores(business_id,employee_id,score_month,ao_dai_count,dress_count,ba_ba_count,submitted_on_time,photographed_at_venue,updated_by)
  values(v_business_id,p_employee_id,v_month,
    case when p_costume_type='ao_dai' then p_quantity else 0 end,
    case when p_costume_type='dress' then p_quantity else 0 end,
    case when p_costume_type='ba_ba' then p_quantity else 0 end,
    true,p_photo_path is not null,(select auth.uid()))
  on conflict(business_id,employee_id,score_month) do update set
    ao_dai_count=public.costume_monthly_scores.ao_dai_count+case when p_costume_type='ao_dai' then p_quantity else 0 end,
    dress_count=public.costume_monthly_scores.dress_count+case when p_costume_type='dress' then p_quantity else 0 end,
    ba_ba_count=public.costume_monthly_scores.ba_ba_count+case when p_costume_type='ba_ba' then p_quantity else 0 end,
    photographed_at_venue=public.costume_monthly_scores.photographed_at_venue or excluded.photographed_at_venue,
    updated_by=(select auth.uid()),updated_at=now();
  return v_submission_id;
end
$function$;

grant execute on function public.add_costume_submission(bigint,date,text,integer,text,text,bigint) to authenticated;
