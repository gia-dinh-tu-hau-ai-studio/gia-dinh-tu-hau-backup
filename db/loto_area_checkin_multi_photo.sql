-- Lưu nhiều ảnh cho mỗi lần Check In / Check Out (tối đa 20 ảnh ở giao diện).
-- Giữ các cột text cũ để tương thích với Edge Function và dữ liệu đã có.
alter table public.loto_area_attendance
  add column if not exists check_in_photo_paths text[] not null default '{}',
  add column if not exists check_out_photo_paths text[] not null default '{}';

create index if not exists loto_area_attendance_checkin_photos_gin
  on public.loto_area_attendance using gin(check_in_photo_paths);
create index if not exists loto_area_attendance_checkout_photos_gin
  on public.loto_area_attendance using gin(check_out_photo_paths);
