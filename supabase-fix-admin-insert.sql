-- =====================================================================
--  ตามงาน — FIX: "new row violates row-level security policy for app_users"
--  รวม patch-teams + patch-teams-fix1 เป็นไฟล์เดียว + บังคับตั้ง admin
--  วิธีใช้: Supabase Dashboard > SQL Editor > วางทั้งไฟล์ > Run (รันซ้ำได้)
--
--  ต้นเหตุ: เซิร์ฟเวอร์ยังไม่เห็น lewclassic@gmail.com เป็น admin
--           (is_admin() = false) → RLS เลยบล็อกการสร้าง "หัวหน้างาน"
--  ไฟล์นี้แก้ให้จบในไฟล์เดียว ไม่ต้องพึ่งลำดับการรันไฟล์อื่น
-- =====================================================================

-- ---------- 0) กัน dependency: ตาราง todos (เผื่อยังไม่เคยรัน patch-security) ----------
create table if not exists todos (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid references app_users(id) on delete cascade,
  text       text,
  done       boolean default false,
  created_at timestamptz default now()
);
create index if not exists idx_todos_owner on todos(owner);

-- ---------- 1) คอลัมน์ทีม/แอดมิน ----------
alter table app_users add column if not exists manager_id uuid references app_users(id) on delete set null;
alter table app_users add column if not exists is_admin   boolean default false;
create index if not exists idx_users_manager on app_users(manager_id);

-- ---------- 2) *** บังคับตั้ง admin (ต้นเหตุของ error) *** ----------
update app_users
   set is_admin = true, is_boss = true, active = true, manager_id = null
 where lower(email) = 'lewclassic@gmail.com';

-- ผู้ใช้อื่นที่ยังไม่มีสังกัด → ยกให้ admin คนนี้ดูแล
update app_users u
   set manager_id = (select id from app_users where lower(email) = 'lewclassic@gmail.com' limit 1)
 where u.manager_id is null
   and lower(coalesce(u.email,'')) <> 'lewclassic@gmail.com';

-- ---------- 3) Helper functions (SECURITY DEFINER — เลี่ยง RLS วนซ้ำ) ----------
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

create or replace function is_boss() returns boolean
  language sql security definer stable as $$
  select coalesce((select is_boss from me_row()), false)
      or coalesce((select is_admin from me_row()), false)
$$;

create or replace function manage_scope() returns setof uuid
language sql security definer stable as $$
  select u.id
    from app_users u
   where (select is_admin from me_row())
      or u.id = (select id from me_row())
      or ( (select is_boss from me_row()) and u.manager_id = (select id from me_row()) )
$$;

create or replace function visible_users() returns setof uuid
language sql security definer stable as $$
  select * from manage_scope()
  union
  select manager_id from me_row() where manager_id is not null
$$;

-- ---------- 4) RLS: app_users (insert แบบง่ายจาก fix1 — คุมค่าจริงที่ trigger) ----------
alter table app_users enable row level security;

drop policy if exists u_sel on app_users;
create policy u_sel on app_users for select
  using ( id in (select visible_users()) );

drop policy if exists u_ins on app_users;
create policy u_ins on app_users for insert with check ( is_boss() );

drop policy if exists u_upd on app_users;
create policy u_upd on app_users for update
  using  ( id in (select manage_scope()) )
  with check ( id in (select manage_scope()) );

drop policy if exists u_del on app_users;
create policy u_del on app_users for delete
  using ( is_admin() or ( is_boss() and manager_id = me_id() and id <> me_id() ) );

-- ---------- 5) Triggers: คุมสิทธิ์ตอนแก้/เพิ่มสมาชิก (จาก fix1) ----------
create or replace function guard_user_update() returns trigger
  language plpgsql security definer as $$
begin
  if is_admin() then
    return new;
  end if;
  if is_boss() then
    if new.is_boss  is distinct from old.is_boss
    or new.is_admin is distinct from old.is_admin then
      raise exception 'ตั้งสิทธิ์หัวหน้า/แอดมินได้เฉพาะผู้ดูแลระบบ';
    end if;
    if new.manager_id is distinct from old.manager_id then
      raise exception 'ย้ายสมาชิกข้ามทีมได้เฉพาะผู้ดูแลระบบ';
    end if;
    return new;
  end if;
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

create or replace function guard_user_insert() returns trigger
  language plpgsql security definer as $$
declare
  v_email text := coalesce(auth.email(), '(ไม่มีอีเมลใน session)');
  v_admin boolean := is_admin();
  v_boss  boolean := is_boss();
  v_me    uuid := me_id();
begin
  if v_admin then
    return new;                       -- แอดมิน: ตั้งค่าอะไรก็ได้
  end if;

  if not v_boss then
    raise exception 'เพิ่มสมาชิกไม่ได้ — เซิร์ฟเวอร์เห็นคุณเป็น: อีเมล=% / is_admin=% / is_boss=% / user_id=%',
      v_email, v_admin, v_boss, coalesce(v_me::text, 'NULL');
  end if;

  if coalesce(new.is_boss,false) or coalesce(new.is_admin,false) then
    raise exception 'ตั้ง "หัวหน้างาน" หรือ "แอดมิน" คนใหม่ได้เฉพาะผู้ดูแลระบบ — เซิร์ฟเวอร์เห็นคุณเป็น: อีเมล=% / is_admin=% / is_boss=%',
      v_email, v_admin, v_boss;
  end if;

  if v_me is null then
    raise exception 'ไม่พบบัญชีของคุณในตาราง app_users (อีเมลใน session = %) — ตรวจว่าอีเมลตรงกันและ active = true', v_email;
  end if;

  new.is_boss    := false;
  new.is_admin   := false;
  new.manager_id := v_me;
  return new;
end $$;
drop trigger if exists trg_user_insert on app_users;
create trigger trg_user_insert before insert on app_users
  for each row execute function guard_user_insert();

-- ---------- 6) เครื่องมือตรวจสิทธิ์ (เรียกจากแอปได้ผ่าน rpc) ----------
create or replace function whoami()
returns table (session_email text, user_id uuid, admin boolean, boss boolean)
language sql security definer stable as $$
  select auth.email(), me_id(), is_admin(), is_boss()
$$;
grant execute on function whoami() to anon, authenticated;

-- ---------- 7) ตรวจผล ----------
--  ควรเห็น lewclassic@gmail.com ที่ is_admin = true
select name, email, is_admin, is_boss, manager_id
  from app_users
 order by is_admin desc, is_boss desc, name;
