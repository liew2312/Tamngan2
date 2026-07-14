-- =====================================================================
--  ตามงาน — Security Patch #1 (14 ก.ค. 2026)
--  วิธีใช้: Supabase Dashboard > SQL Editor > วางทั้งไฟล์ > Run (รันซ้ำได้)
--
--  แก้ 4 เรื่อง:
--  A. กันสมาชิกตั้ง is_boss/active/email/name/role ให้ตัวเอง (privilege escalation)
--  B. กันสมาชิกเลื่อน due_date งานตัวเองเงียบๆ (KPI gaming)
--  C. ตาราง todos — to-do ส่วนตัว sync ข้ามเครื่อง (เห็นเฉพาะเจ้าของ)
--  D. is_boss() อ่านจากตารางอย่างเดียว ไม่ hardcode อีเมล
-- =====================================================================

-- ---------- D. is_boss() ไม่ hardcode อีเมล ----------
-- (สิทธิ์หัวหน้ามาจากคอลัมน์ app_users.is_boss เท่านั้น — seed ไว้แล้วในสคีมาเดิม)
create or replace function is_boss() returns boolean
  language sql security definer stable as $$
  select coalesce(
           (select is_boss from app_users
             where lower(email) = lower(auth.email()) and active is not false
             limit 1),
           false)
$$;

-- ---------- A. กันสมาชิกแก้คอลัมน์สิทธิ์ของตัวเอง ----------
-- สมาชิกแก้ได้เฉพาะ: photo, status, last_login (ที่แอปใช้จริงใน updateProfile/touchActive)
create or replace function guard_user_update() returns trigger
  language plpgsql security definer as $$
begin
  if not is_boss() then
    if new.is_boss is distinct from old.is_boss
       or new.active is distinct from old.active
       or new.email  is distinct from old.email
       or new.name   is distinct from old.name
       or new.role   is distinct from old.role
       or new.color  is distinct from old.color then
      raise exception 'สมาชิกแก้ได้เฉพาะรูปโปรไฟล์และสเตตัส — ข้อมูลอื่นต้องให้หัวหน้าแก้';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_user_update on app_users;
create trigger trg_user_update before update on app_users
  for each row execute function guard_user_update();

-- ---------- B. กันสมาชิกเลื่อนกำหนดส่ง / แก้เนื้องานเอง ----------
-- แทนที่ guard_task_update เดิม: เพิ่มเช็ค due_date (ของเดิมเช็คแค่ status/assignee)
-- สมาชิกยังทำได้ตามปกติ: อัปเดต progress, เปลี่ยนสถานะเป็น กำลังทำ/รอตรวจ
create or replace function guard_task_update() returns trigger
  language plpgsql security definer as $$
begin
  if not is_boss() then
    if new.status in ('เสร็จแล้ว','ยกเลิก') and coalesce(old.status,'') <> new.status then
      raise exception 'ต้องให้หัวหน้าอนุมัติหรือยกเลิกงาน';
    end if;
    if coalesce(new.assignee::text,'') <> coalesce(old.assignee::text,'') then
      raise exception 'พนักงานเปลี่ยนผู้รับผิดชอบไม่ได้';
    end if;
    if new.due_date is distinct from old.due_date then
      raise exception 'พนักงานเลื่อนกำหนดส่งเองไม่ได้ — ต้องให้หัวหน้าเลื่อนให้ (มีบันทึกประวัติ)';
    end if;
  end if;
  if new.status = 'เสร็จแล้ว' and coalesce(old.status,'') <> 'เสร็จแล้ว' and new.completed_at is null then
    new.completed_at := now();
  end if;
  if new.status <> 'เสร็จแล้ว' then
    new.completed_at := null;
  end if;
  return new;
end $$;
drop trigger if exists trg_task_update on tasks;
create trigger trg_task_update before update on tasks
  for each row execute function guard_task_update();

-- ---------- C. ตาราง todos (to-do ส่วนตัว sync ข้ามเครื่อง) ----------
create table if not exists todos (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references app_users(id) on delete cascade,
  text       text not null,
  tag        text,
  priority   text default 'ปกติ',
  date       date,
  done       boolean default false,
  created_at timestamptz default now()
);
create index if not exists idx_todos_owner on todos(owner);

alter table todos enable row level security;
-- เห็น/แก้/ลบได้เฉพาะของตัวเอง — หัวหน้าก็มองไม่เห็นของคนอื่น (เป็นโน้ตส่วนตัว)
drop policy if exists td_sel on todos;
create policy td_sel on todos for select using ( owner = me_id() );
drop policy if exists td_ins on todos;
create policy td_ins on todos for insert with check ( owner = me_id() );
drop policy if exists td_upd on todos;
create policy td_upd on todos for update using ( owner = me_id() ) with check ( owner = me_id() );
drop policy if exists td_del on todos;
create policy td_del on todos for delete using ( owner = me_id() );
