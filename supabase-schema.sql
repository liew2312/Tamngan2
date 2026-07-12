-- =====================================================================
--  ตามงาน — Supabase schema + RLS
--  วิธีใช้: Supabase Dashboard > SQL Editor > วางทั้งไฟล์ > Run
--  (รันซ้ำได้ ปลอดภัย ใช้ if not exists / or replace)
-- =====================================================================

-- ---------- ตาราง ----------
create table if not exists app_users (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  role       text default 'ทีมงาน',
  email      text unique,
  color      text,
  is_boss    boolean default false,
  photo      text,
  status     text,
  active     boolean default true,
  created_at timestamptz default now()
);

create table if not exists tasks (
  id           uuid primary key default gen_random_uuid(),
  project      text,
  title        text not null,
  description  text,
  assignee     uuid references app_users(id) on delete set null,
  due_date     date,
  status       text default 'ยังไม่เริ่ม',
  progress     int  default 0,
  priority     text default 'ปกติ',
  completed_at timestamptz,
  created_at   timestamptz default now()
);

create table if not exists comments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid references tasks(id) on delete cascade,
  author     uuid references app_users(id) on delete set null,
  message    text,
  created_at timestamptz default now()
);

create table if not exists due_log (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid references tasks(id) on delete cascade,
  old_date   text,
  new_date   text,
  reason     text,
  by_user    uuid,
  by_name    text,
  created_at timestamptz default now()
);

create index if not exists idx_tasks_assignee on tasks(assignee);
create index if not exists idx_comments_task on comments(task_id);
create index if not exists idx_duelog_task on due_log(task_id);

-- ---------- ฟังก์ชันช่วย (SECURITY DEFINER เพื่อเลี่ยง RLS วนซ้ำ) ----------
create or replace function me_id() returns uuid
  language sql security definer stable as $$
  select id from app_users where email = (auth.jwt() ->> 'email') limit 1
$$;

create or replace function is_boss() returns boolean
  language sql security definer stable as $$
  select coalesce((select is_boss from app_users
                   where email = (auth.jwt() ->> 'email') limit 1), false)
$$;

-- ---------- เปิด RLS ----------
alter table app_users enable row level security;
alter table tasks     enable row level security;
alter table comments  enable row level security;
alter table due_log   enable row level security;

-- app_users: หัวหน้าเห็นทุกคน / พนักงานเห็นเฉพาะตัวเอง
drop policy if exists u_sel on app_users;
create policy u_sel on app_users for select
  using ( is_boss() or email = (auth.jwt() ->> 'email') );
drop policy if exists u_ins on app_users;
create policy u_ins on app_users for insert with check ( is_boss() );
drop policy if exists u_upd on app_users;
create policy u_upd on app_users for update
  using ( is_boss() or email = (auth.jwt() ->> 'email') );
drop policy if exists u_del on app_users;
create policy u_del on app_users for delete using ( is_boss() );

-- tasks: หัวหน้าเห็น/แก้ทุกงาน / พนักงานเห็น-อัปเดตเฉพาะงานตัวเอง
drop policy if exists t_sel on tasks;
create policy t_sel on tasks for select using ( is_boss() or assignee = me_id() );
drop policy if exists t_ins on tasks;
create policy t_ins on tasks for insert with check ( is_boss() );
drop policy if exists t_upd on tasks;
create policy t_upd on tasks for update using ( is_boss() or assignee = me_id() );
drop policy if exists t_del on tasks;
create policy t_del on tasks for delete using ( is_boss() );

-- กันพนักงานอนุมัติ/ยกเลิกเอง + ตั้ง completed_at อัตโนมัติ
create or replace function guard_task_update() returns trigger
  language plpgsql as $$
begin
  if not is_boss() then
    if new.status in ('เสร็จแล้ว','ยกเลิก') and coalesce(old.status,'') <> new.status then
      raise exception 'ต้องให้หัวหน้าอนุมัติหรือยกเลิกงาน';
    end if;
    if coalesce(new.assignee::text,'') <> coalesce(old.assignee::text,'') then
      raise exception 'พนักงานเปลี่ยนผู้รับผิดชอบไม่ได้';
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

-- comments
drop policy if exists c_sel on comments;
create policy c_sel on comments for select
  using ( is_boss() or exists (select 1 from tasks where tasks.id = comments.task_id and tasks.assignee = me_id()) );
drop policy if exists c_ins on comments;
create policy c_ins on comments for insert with check ( author = me_id() );

-- due_log
drop policy if exists d_sel on due_log;
create policy d_sel on due_log for select
  using ( is_boss() or exists (select 1 from tasks where tasks.id = due_log.task_id and tasks.assignee = me_id()) );
drop policy if exists d_ins on due_log;
create policy d_ins on due_log for insert with check ( is_boss() );

-- ---------- Realtime (กันรันซ้ำ) ----------
do $$
begin
  alter publication supabase_realtime add table tasks;
exception
  when duplicate_object then null;  -- ถ้าเพิ่มไว้แล้ว ข้ามไป
end $$;

-- ---------- Seed หัวหน้าทีม (แก้อีเมลให้ตรงของคุณ) ----------
insert into app_users (name, role, email, color, is_boss, active)
values ('หัวหน้าทีม', 'Manager', 'lewclassic@gmail.com', '#5b82e0', true, true)
on conflict (email) do update set is_boss = true, active = true;
