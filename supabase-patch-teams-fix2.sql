-- =====================================================================
--  ตามงาน — Patch #2.2 (ฉบับรวม — ใช้แทน fix1 ได้เลย)
--  วิธีใช้: Supabase Dashboard > SQL Editor > วางทั้งไฟล์ > Run (รันซ้ำได้)
--  ต้องรัน supabase-patch-teams.sql ก่อน (ตัวที่เพิ่มคอลัมน์ manager_id / is_admin)
--
--  ทำไมต้องมีไฟล์นี้
--    การ "เพิ่มสมาชิก" ผ่าน RLS INSERT มีหลายชั้น (policy WITH CHECK + trigger)
--    เวลาโดนปฏิเสธ Postgres บอกแค่ "new row violates row-level security policy"
--    ไล่ไม่ได้ว่าชั้นไหน  →  ย้ายการเขียนข้อมูลสมาชิกทั้งหมดไปเป็นฟังก์ชัน
--    SECURITY DEFINER (RPC) ที่ตรวจสิทธิ์เองและ raise ข้อความไทยชัดเจน
--    การ "อ่าน" ยังคุมด้วย RLS เหมือนเดิม (นั่นคือหัวใจของการแยกทีม)
-- =====================================================================

-- ---------- 1) me_row() ให้ทนทานขึ้น ----------
--  - trim ช่องว่างหัวท้ายอีเมล (กันข้อมูลเก่าที่พิมพ์ติดสเปซ)
--  - ถ้า auth.email() ว่าง ให้ลองอ่านจาก JWT ตรงๆ (บาง provider ไม่ใส่ claim email ชั้นบน)
--  - ไม่ตัดคนที่ active = false ออกจาก "การระบุตัวตน" (เอาไปเช็คตอนให้สิทธิ์แทน)
--    ไม่งั้นถ้าเผลอปิดบัญชีตัวเอง จะกลายเป็นมองไม่เห็นอะไรเลยและกู้ไม่ได้
create or replace function my_email() returns text
  language sql stable as $$
  select lower(trim(coalesce(
           nullif(auth.email(), ''),
           nullif(current_setting('request.jwt.claims', true)::json ->> 'email', ''),
           nullif(current_setting('request.jwt.claims', true)::json -> 'user_metadata' ->> 'email', ''),
           '')))
$$;

-- หมายเหตุ: คง "หน้าตา" ของ me_row() ไว้เหมือนเดิม (4 คอลัมน์)
--           เพราะ create or replace เปลี่ยน return type ไม่ได้
create or replace function me_row()
returns table (id uuid, is_boss boolean, is_admin boolean, manager_id uuid)
language sql security definer stable as $$
  select u.id,
         coalesce(u.is_boss,  false),
         coalesce(u.is_admin, false),
         u.manager_id
    from app_users u
   where my_email() <> ''
     and lower(trim(coalesce(u.email,''))) = my_email()
   limit 1
$$;

-- บัญชีถูกปิดใช้งานหรือไม่ (แยกออกมา จะได้ยังระบุตัวตนได้แม้โดนปิด)
create or replace function me_active() returns boolean
  language sql security definer stable as $$
  select coalesce((select coalesce(u.active,true) from app_users u
                    where my_email() <> ''
                      and lower(trim(coalesce(u.email,''))) = my_email()
                    limit 1), false) $$;

create or replace function me_id() returns uuid
  language sql security definer stable as $$ select r.id from me_row() r $$;

create or replace function is_admin() returns boolean
  language sql security definer stable as $$
  select coalesce((select r.is_admin from me_row() r), false) and me_active() $$;

create or replace function is_boss() returns boolean
  language sql security definer stable as $$
  select coalesce((select (r.is_boss or r.is_admin) from me_row() r), false) and me_active() $$;

-- ---------- 2) ตัวตรวจสิทธิ์ (เรียกจากแอปได้) ----------
drop function if exists whoami();
create function whoami()
returns table (session_email text, user_id uuid, admin boolean, boss boolean, found boolean)
language sql security definer stable as $$
  select my_email(),
         (select r.id from me_row() r),
         is_admin(),
         is_boss(),
         exists (select 1 from me_row())
$$;

-- ---------- 2.5) ขอบเขตการมองเห็น — ผูกกับ is_admin()/is_boss() ----------
--  (ของเดิมอ่าน me_row() ตรงๆ ทำให้บัญชีที่ถูกปิดใช้งานยังเห็นงานทีมอยู่)
create or replace function manage_scope() returns setof uuid
language sql security definer stable as $$
  select u.id
    from app_users u
   where is_admin()
      or u.id = me_id()
      or ( is_boss() and u.manager_id = me_id() )
$$;

-- ---------- 3) มองเห็นตัวเองเสมอ (กันสถานะล็อกตาย) ----------
drop policy if exists u_sel on app_users;
create policy u_sel on app_users for select
  using ( id in (select visible_users())
          or lower(trim(coalesce(email,''))) = my_email() );

-- ---------- 4) ปิดการเขียน app_users ตรงๆ จากฝั่งแอป ----------
--  ทุกอย่างต้องผ่าน RPC ด้านล่าง (ซึ่งตรวจสิทธิ์เองอย่างเข้มงวด)
drop trigger if exists trg_user_insert on app_users;   -- ไม่ต้องใช้แล้ว
drop function if exists guard_user_insert();

drop policy if exists u_ins on app_users;
create policy u_ins on app_users for insert with check ( false );

drop policy if exists u_del on app_users;
create policy u_del on app_users for delete using ( false );

-- update: ปล่อยให้สมาชิกแก้ profile ตัวเองได้ (แอปใช้ updateProfile/touchActive)
--         ส่วนการแก้ข้อมูลคนอื่น ใช้ RPC
drop policy if exists u_upd on app_users;
create policy u_upd on app_users for update
  using ( lower(trim(coalesce(email,''))) = my_email() )
  with check ( lower(trim(coalesce(email,''))) = my_email() );

-- trigger เดิมยังคุมไม่ให้สมาชิกยกระดับสิทธิ์ตัวเอง — สร้างใหม่ให้ชัด
create or replace function guard_user_update() returns trigger
  language plpgsql security definer as $$
begin
  -- ปล่อยผ่านถ้าถูกเรียกจาก RPC tn_update_user (ซึ่งตรวจสิทธิ์ครบแล้ว)
  if coalesce(current_setting('tamngan.rpc', true), '') = '1' then return new; end if;
  if is_admin() then return new; end if;
  if new.is_boss    is distinct from old.is_boss
  or new.is_admin   is distinct from old.is_admin
  or new.manager_id is distinct from old.manager_id
  or new.active     is distinct from old.active
  or new.email      is distinct from old.email
  or new.name       is distinct from old.name
  or new.role       is distinct from old.role
  or new.color      is distinct from old.color then
    raise exception 'แก้ได้เฉพาะรูปโปรไฟล์และสเตตัสของตัวเอง — ข้อมูลอื่นต้องให้หัวหน้าแก้';
  end if;
  return new;
end $$;
drop trigger if exists trg_user_update on app_users;
create trigger trg_user_update before update on app_users
  for each row execute function guard_user_update();

-- ---------- 5) RPC: เพิ่มสมาชิก ----------
create or replace function tn_add_user(
  p_name text, p_role text, p_email text,
  p_manager uuid default null, p_is_boss boolean default false
) returns app_users
language plpgsql security definer as $$
declare
  v_admin boolean := is_admin();
  v_boss  boolean := is_boss();
  v_me    uuid    := me_id();
  v_mail  text    := nullif(lower(trim(coalesce(p_email,''))), '');
  v_mgr   uuid;
  v_row   app_users;
  v_colors text[] := array['#5b82e0','#e8536e','#e8942f','#22a97a','#a06ddb','#3fa9c4','#e07b9a'];
begin
  if v_me is null then
    raise exception 'ไม่พบบัญชีของคุณในระบบ (อีเมลจาก session = "%") — ตรวจว่าอีเมลในตาราง app_users ตรงกันเป๊ะ', coalesce(my_email(),'(ว่าง)');
  end if;
  if not v_boss then
    raise exception 'เฉพาะหัวหน้างานเท่านั้นที่เพิ่มสมาชิกได้ (อีเมล=% / is_admin=% / is_boss=%)', my_email(), v_admin, v_boss;
  end if;
  if coalesce(trim(p_name),'') = '' then
    raise exception 'กรุณากรอกชื่อ';
  end if;
  if v_mail is not null and exists (select 1 from app_users where lower(trim(coalesce(email,''))) = v_mail) then
    raise exception 'อีเมล % ถูกใช้ไปแล้ว', v_mail;
  end if;

  if v_admin then
    -- แอดมิน: ตั้งหัวหน้างานใหม่ได้ และเลือกสังกัดได้อิสระ
    v_mgr := p_manager;
    if not coalesce(p_is_boss,false) and v_mgr is null then v_mgr := v_me; end if;
  else
    -- หัวหน้างานทั่วไป: ได้เฉพาะลูกน้องในทีมตัวเอง
    if coalesce(p_is_boss,false) then
      raise exception 'ตั้งหัวหน้างานคนใหม่ได้เฉพาะผู้ดูแลระบบ';
    end if;
    v_mgr := v_me;
  end if;

  insert into app_users (name, role, email, is_boss, is_admin, manager_id, active, color)
  values (trim(p_name),
          coalesce(nullif(trim(coalesce(p_role,'')),''), 'ทีมงาน'),
          v_mail,
          v_admin and coalesce(p_is_boss,false),
          false,
          v_mgr,
          true,
          v_colors[1 + floor(random()*array_length(v_colors,1))::int])
  returning * into v_row;
  return v_row;
end $$;

-- ---------- 6) RPC: แก้ไขสมาชิก ----------
create or replace function tn_update_user(
  p_id uuid, p_name text, p_role text, p_email text,
  p_is_boss boolean, p_active boolean, p_manager uuid default null,
  p_set_manager boolean default false
) returns app_users
language plpgsql security definer as $$
declare
  v_admin boolean := is_admin();
  v_boss  boolean := is_boss();
  v_me    uuid    := me_id();
  v_mail  text    := nullif(lower(trim(coalesce(p_email,''))), '');
  v_tgt   app_users;
  v_row   app_users;
begin
  select * into v_tgt from app_users where id = p_id;
  if v_tgt.id is null then raise exception 'ไม่พบสมาชิกที่ต้องการแก้'; end if;
  if not v_boss then raise exception 'เฉพาะหัวหน้างานเท่านั้นที่แก้ข้อมูลสมาชิกได้'; end if;
  if not v_admin and v_tgt.manager_id is distinct from v_me and v_tgt.id <> v_me then
    raise exception 'แก้ได้เฉพาะลูกน้องในทีมตัวเอง';
  end if;
  if v_mail is not null and exists (
       select 1 from app_users where lower(trim(coalesce(email,''))) = v_mail and id <> p_id) then
    raise exception 'อีเมล % ถูกใช้ไปแล้ว', v_mail;
  end if;

  perform set_config('tamngan.rpc', '1', true);   -- true = เฉพาะทรานแซกชันนี้
  update app_users set
    name       = coalesce(nullif(trim(coalesce(p_name,'')),''), name),
    role       = coalesce(nullif(trim(coalesce(p_role,'')),''), 'ทีมงาน'),
    email      = v_mail,
    is_boss    = case when v_admin then coalesce(p_is_boss,false) else is_boss end,
    active     = coalesce(p_active, true),
    manager_id = case when v_admin and p_set_manager then p_manager else manager_id end
  where id = p_id
  returning * into v_row;
  perform set_config('tamngan.rpc', '0', true);
  return v_row;
end $$;

-- ---------- 7) RPC: ลบสมาชิก ----------
create or replace function tn_delete_user(p_id uuid) returns boolean
language plpgsql security definer as $$
declare
  v_admin boolean := is_admin();
  v_boss  boolean := is_boss();
  v_me    uuid    := me_id();
  v_tgt   app_users;
  v_cnt   int;
begin
  select * into v_tgt from app_users where id = p_id;
  if v_tgt.id is null then return true; end if;
  if not v_boss then raise exception 'เฉพาะหัวหน้างานเท่านั้นที่ลบสมาชิกได้'; end if;
  if p_id = v_me then raise exception 'ลบบัญชีตัวเองไม่ได้'; end if;
  if not v_admin and v_tgt.manager_id is distinct from v_me then
    raise exception 'ลบได้เฉพาะลูกน้องในทีมตัวเอง';
  end if;
  select count(*) into v_cnt from tasks where assignee = p_id;
  if v_cnt > 0 then
    raise exception 'ลบไม่ได้ ยังมีงานอยู่ % งาน — ย้ายผู้รับผิดชอบหรือลบงานก่อน (หรือปิดการใช้งานแทน)', v_cnt;
  end if;
  if exists (select 1 from app_users where manager_id = p_id) then
    raise exception 'ลบไม่ได้ — ยังมีลูกน้องสังกัดอยู่ ย้ายทีมให้เรียบร้อยก่อน';
  end if;
  delete from app_users where id = p_id;
  return true;
end $$;

-- ---------- 8) สิทธิ์เรียกใช้ ----------
grant execute on function my_email()      to anon, authenticated;
grant execute on function whoami()        to anon, authenticated;
grant execute on function tn_add_user(text,text,text,uuid,boolean)                       to authenticated;
grant execute on function tn_update_user(uuid,text,text,text,boolean,boolean,uuid,boolean) to authenticated;
grant execute on function tn_delete_user(uuid)                                            to authenticated;

notify pgrst, 'reload schema';

-- =====================================================================
--  ตรวจผล (รันแยกได้)
--    select name, email, is_admin, is_boss, active, manager_id from app_users order by created_at;
-- =====================================================================
