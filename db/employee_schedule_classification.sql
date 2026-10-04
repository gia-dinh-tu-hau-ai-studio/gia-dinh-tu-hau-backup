alter table public.employees
  add column if not exists scheduling_level text not null default 'C',
  add column if not exists scheduling_symbol text,
  add column if not exists scheduling_note text;

alter table public.employees drop constraint if exists employees_scheduling_level_check;
update public.employees set scheduling_level='C' where scheduling_level='D';
alter table public.employees add constraint employees_scheduling_level_check
  check (scheduling_level in ('A','B','C','D'));
