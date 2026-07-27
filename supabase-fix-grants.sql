-- =====================================================================
--  ตามงาน — FIX: 403 Forbidden ทุก request ที่ยิงตรงไปตาราง
--  (GET select=* และ POST insert ได้ 403 / error 42501 "violates RLS")
--
--  ต้นเหตุ: role anon/authenticated ไม่มี GRANT บนตารางใน schema public
--           (RLS เปิดไว้ถูกแล้ว แต่สิทธิ์ตารางพื้นฐานหาย)
--  วิธีใช้: Supabase Dashboard > SQL Editor > วางทั้งไฟล์ > Run (รันซ้ำได้)
--  หมายเหตุ: ต้องรันใน SQL Editor เท่านั้น — ไม่ใช่ Console ของเบราว์เซอร์
-- =====================================================================

-- ให้เข้าถึง schema
grant usage on schema public to anon, authenticated;

-- ให้สิทธิ์ตารางทั้งหมด (RLS ยังเป็นตัวคุมสิทธิ์จริงอยู่)
grant select, insert, update, delete on all tables in schema public to anon, authenticated;

-- ให้สิทธิ์ sequence (เผื่อคอลัมน์ที่ใช้ default/serial)
grant usage, select on all sequences in schema public to anon, authenticated;

-- ตั้ง default ให้ตารางที่สร้างใหม่ในอนาคตได้สิทธิ์นี้อัตโนมัติ
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated;
alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated;

-- ---------- ตรวจผล: ควรเห็นสิทธิ์ของ app_users ครบ ----------
select grantee, privilege_type
  from information_schema.role_table_grants
 where table_name = 'app_users'
   and grantee in ('anon','authenticated')
 order by grantee, privilege_type;
