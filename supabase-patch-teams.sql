-- =====================================================================
--  ตามงาน — Patch #2: หลายทีม / หลายหัวหน้างาน (27 ก.ค. 2026)
--  วิธีใช้: Supabase Dashboard > SQL Editor > วางทั้งไฟล์ > Run (รันซ้ำได้)
--
--  สิ่งที่เปลี่ยน
--  1) เพิ่มคอลัมน์ app_users.manager_id (สังกัดหัวหน้างานคนไหน)
--     และ app_users.is_admin (ผู้ดูแลระบบ เห็นทุกทีม)
--  2) สิทธิ์ 3 ระดับ
--     - Admin        : เห็น/แก้ทุกทีม, สร้างหัวหน้างานได้, ย้ายคนข้ามทีมได้
--     - หัวหน้างาน   : เห็นเฉพาะลูกน้องในทีมตัวเอง + งานของทีมตัวเอง
--                      เพิ่ม/แก้/ลบลูกน้องของตัวเองได้ (ตั้งหัวหน้า/แอดมินไม่ได้)
--     - ลูกน้อง      : เห็นเฉพาะงานตัวเอง (เหมือนเดิม)
--  3) Backfill: ผู้ใช้เดิมทั้งหมดย้ายไปสังกัด lewclassic@gmail.com
--     และตั้งให้อีเมลนั้นเป็น Admin
--
--  ⚠ รันไฟล์นี้ "หลัง" supabase-schema.sql และ supabase-patch-security.sql
-- =====================================================================

-- ---------- 1) คอลัมน์ใหม่ ----------
alter table app_users add column if not exists manager_id uuid references app_users(id) on delete set null;
alter table app_users add column if not exists is_admin   boolean default false;
create index if not exists idx_users_manager on app_users(manager_id);

-- ---------- 2) Backfill (ทำก่อนเปลี่ยน policy จะได้ไม่มีคนตกหล่น) ----------
-- ตั้ง lewclassic@gmail.com เป็น Admin + หัวหน้า
update app_users
   set is_admin = true, is_boss = true, manager_id = null
 where lower(email) = 'lewclassic@gmail.com';

-- ผู้ใช้อื่นทั้งหมดที่ยังไม่มีสังกัด → ยกให้ Admin คนนั้น
update app_users u
   set manager_id = (select id from app_users where lower(email) = 'lewclassic@gmail.com' limit 1)
 where u.manager_id is null
   and lower(coalesce(u.email,'')) <> 'lewclassic@gmail.com';

-- ---------- 3) Helper functions (SECURITY DEFINER — เลี่ยง RLS วนซ้ำ) ----------

-- แถวของ "ฉัน"
create or replace function me_row()
returns table (id uuid, is_boss boolean, is_admin boolean, manager_id uuid)
language sql security definer stable as $$
  select id, coalesce(is_boss,false), coalesce(is_admin,false), manager_id
    from app_users
   where lower(email) = lower(auth.email())
     and active is not false
   limit 1
$$;

create or replace function me_id() returns uuid
  language sql security definer stable as $$ select id from me_row() $$;

create or replace function is_admin() returns boolean
  language sql security definer stable as $$ select coalesce((select is_admin from me_row()), false) $$;

-- is_boss() = หัวหน้างาน หรือ แอดมิน (โค้ดหน้าเว็บเดิมใช้ตัวนี้ตัดสินสิทธิ์ "หัวหน้า")
create or replace function is_boss() returns boolean
  language sql security definer stable as $$
  select coalesce((select is_boss from me_row()), false)
      or coalesce((select is_admin from me_row()), false)
$$;

-- ขอบเขต "คนที่ฉันดูแลงานได้"
--   admin      → ทุกคน
--   หัวหน้างาน → ตัวเอง + ลูกน้องที่สังกัดตัวเอง
--   ลูกน้อง    → ตัวเอง
create or replace function manage_scope() returns setof uuid
language sql security definer stable as $$
  select u.id
    from app_users u
   where (select is_admin from me_row())
      or u.id = (select id from me_row())
      or ( (select is_boss from me_row()) and u.manager_id = (select id from me_row()) )
$$;

-- ขอบเขต "คนที่ฉันเห็นชื่อได้" = manage_scope + หัวหน้าของฉัน (ไว้แสดงชื่อในคอมเมนต์)
create or replace function visible_users() returns setof uuid
language sql security definer stable as $$
  select * from manage_scope()
  union
  select manager_id from me_row() where manager_id is not null
$$;

-- ---------- 4) RLS: app_users ----------
alter table app_users enable row level security;

drop policy if exists u_sel on app_users;
create policy u_sel on app_users for select
  using ( id in (select visible_users()) );

drop policy if exists u_ins on app_users;
create policy u_ins on app_users for insert with check (
  is_admin()
  or ( is_boss()
       and manager_id = me_id()
       and coalesce(is_boss,false)  = false
       and coalesce(is_admin,false) = false )
);

drop policy if exists u_upd on app_users;
create policy u_upd on app_users for update
  using  ( id in (select manage_scope()) )
  with check ( id in (select manage_scope()) );

drop policy if exists u_del on app_users;
create policy u_del on app_users for delete
  using ( is_admin()
          or ( is_boss() and manager_id = me_id() and id <> me_id() ) );

-- Trigger กันยกระดับสิทธิ์เอง / หัวหน้าย้ายคนข้ามทีม
create or replace function guard_user_update() returns trigger
  language plpgsql security definer as $$
begin
  if is_admin() then
    return new;                                    -- แอดมินแก้ได้ทุกอย่าง
  end if;

  if is_boss() then
    -- หัวหน้างาน: แก้ข้อมูลลูกน้องตัวเองได้ แต่ตั้งสิทธิ์/ย้ายทีมไม่ได้
    if new.is_boss  is distinct from old.is_boss
    or new.is_admin is distinct from old.is_admin then
      raise exception 'ตั้งสิทธิ์หัวหน้า/แอดมินได้เฉพาะผู้ดูแลระบบ';
    end if;
    if new.manager_id is distinct from old.manager_id then
      raise exception 'ย้ายสมาชิกข้ามทีมได้เฉพาะผู้ดูแลระบบ';
    end if;
    return new;
  end if;

  -- ลูกน้อง: แก้ได้เฉพาะรูปโปรไฟล์ / สเตตัส / last_login
  if new.is_boss    is distinct from old.is_boss
  or new.is_admin   is distinct from old.is_admin
  or new.manager_id is distinct from old.manager_id
  or new.active     is distinct from old.active
  or new.email      is distinct from old.email
  or new.name       is distinct from old.name
  or new.role       is distinct from old.role
  or new.color      is distinct from old.color then
    raise exception 'สมาชิกแก้ได้เฉพาะรูปโปรไฟล์และสเตตัส — ข้อมูลอื่นต้องให้หัวหน้าแก้';
  end if;
  return new;
end $$;
drop trigger if exists trg_user_update on app_users;
create trigger trg_user_update before update on app_users
  for each row execute function guard_user_update();

-- กันหัวหน้าสร้างสมาชิกโดยไม่ระบุสังกัด (เผื่อ client ลืมส่ง manager_id)
create or replace function guard_user_insert() returns trigger
  language plpgsql security definer as $$
begin
  if not is_admin() then
    new.is_boss    := false;
    new.is_admin   := false;
    new.manager_id := me_id();
  end if;
  return new;
end $$;
drop trigger if exists trg_user_insert on app_users;
create trigger trg_user_insert before insert on app_users
  for each row execute function guard_user_insert();

-- ---------- 5) RLS: tasks ----------
alter table tasks enable row level security;

-- หมายเหตุ: งานที่ยังไม่มีผู้รับผิดชอบ (assignee is null) ให้เฉพาะแอดมินเห็น
--           จะได้ไม่มีงานตกหล่นหายไปจากทุกคน
drop policy if exists t_sel on tasks;
create policy t_sel on tasks for select
  using ( assignee in (select manage_scope()) or (assignee is null and is_admin()) );

drop policy if exists t_ins on tasks;
create policy t_ins on tasks for insert
  with check ( is_boss() and (assignee in (select manage_scope()) or (assignee is null and is_admin())) );

drop policy if exists t_upd on tasks;
create policy t_upd on tasks for update
  using  ( assignee in (select manage_scope()) or (assignee is null and is_admin()) )
  with check ( assignee in (select manage_scope()) or (assignee is null and is_admin()) );  -- ย้ายงานออกนอกทีมไม่ได้

drop policy if exists t_del on tasks;
create policy t_del on tasks for delete
  using ( is_boss() and (assignee in (select manage_scope()) or (assignee is null and is_admin())) );

-- guard เดิม (อนุมัติ/ยกเลิก/เลื่อนกำหนดส่ง ต้องเป็นหัวหน้า) — คงไว้ ไม่ต้องแก้
-- แต่สร้างซ้ำไว้ให้ชัวร์ว่ามีอยู่ กรณียังไม่ได้รัน patch-security
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

-- ---------- 6) RLS: comments / due_log (อิงตามงานที่มองเห็น) ----------
alter table comments enable row level security;

drop policy if exists c_sel on comments;
create policy c_sel on comments for select
  using ( exists (select 1 from tasks t
                   where t.id = comments.task_id
                     and t.assignee in (select manage_scope())) );
drop policy if exists c_ins on comments;
create policy c_ins on comments for insert
  with check ( author = me_id()
               and exists (select 1 from tasks t
                            where t.id = comments.task_id
                              and t.assignee in (select manage_scope())) );

alter table due_log enable row level security;

drop policy if exists d_sel on due_log;
create policy d_sel on due_log for select
  using ( exists (select 1 from tasks t
                   where t.id = due_log.task_id
                     and t.assignee in (select manage_scope())) );
drop policy if exists d_ins on due_log;
create policy d_ins on due_log for insert
  with check ( is_boss()
               and exists (select 1 from tasks t
                            where t.id = due_log.task_id
                              and t.assignee in (select manage_scope())) );

-- ---------- 7) todos (ส่วนตัว — ไม่เปลี่ยน แต่ใส่ไว้ให้ครบ) ----------
alter table todos enable row level security;
drop policy if exists td_sel on todos;
create policy td_sel on todos for select using ( owner = me_id() );
drop policy if exists td_ins on todos;
create policy td_ins on todos for insert with check ( owner = me_id() );
drop policy if exists td_upd on todos;
create policy td_upd on todos for update using ( owner = me_id() ) with check ( owner = me_id() );
drop policy if exists td_del on todos;
create policy td_del on todos for delete using ( owner = me_id() );

-- =====================================================================
--  เสร็จแล้ว — ตรวจผลได้ด้วย
--    select name, email, is_admin, is_boss, manager_id from app_users order by is_admin desc, is_boss desc, name;
-- =====================================================================
