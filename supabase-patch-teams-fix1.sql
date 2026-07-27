-- =====================================================================
--  ตามงาน — Patch #2.1 (แก้ insert app_users ติด RLS)
--  รันหลัง supabase-patch-teams.sql — วางทั้งไฟล์ > Run
--
--  เปลี่ยนอะไร
--  - ย้ายการบังคับสิทธิ์ตอน "เพิ่มสมาชิก" จาก policy WITH CHECK ไปไว้ที่ trigger
--    (policy เหลือแค่ "ต้องเป็นหัวหน้า" — ความปลอดภัยเท่าเดิม แต่พังยากกว่า)
--  - ถ้ายังไม่ผ่าน error จะบอกเลยว่าเซิร์ฟเวอร์เห็นคุณเป็นใคร/สิทธิ์อะไร
-- =====================================================================

-- ---------- policy insert แบบง่าย ----------
drop policy if exists u_ins on app_users;
create policy u_ins on app_users for insert with check ( is_boss() );

-- ---------- trigger คุมค่าจริง + แจ้งสิทธิ์เวลาโดนปฏิเสธ ----------
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

  -- หัวหน้างานทั่วไป: สร้างได้เฉพาะลูกน้องในทีมตัวเอง
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

-- ---------- เครื่องมือตรวจสิทธิ์ (เรียกจากแอปได้ผ่าน rpc) ----------
create or replace function whoami()
returns table (session_email text, user_id uuid, admin boolean, boss boolean)
language sql security definer stable as $$
  select auth.email(), me_id(), is_admin(), is_boss()
$$;
grant execute on function whoami() to anon, authenticated;
