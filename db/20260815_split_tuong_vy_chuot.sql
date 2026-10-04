-- Giữ nguyên hồ sơ Tường Vy thuộc Loto và chỉ đổi tên hồ sơ Quán Nước.
-- Điều kiện department bảo đảm không sửa nhầm lịch, lương hoặc dữ liệu làm việc của Tường Vy Loto.
update public.employees
set full_name = 'Chuột'
where department = 'water'
  and upper(trim(full_name)) = 'TƯỜNG VY';

