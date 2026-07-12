# ย้าย "ตามงาน" มาใช้ Supabase

ทำให้แอปเร็วขึ้น (Postgres ระดับมิลลิวินาที), มี **Realtime** (เด้งทันทีเมื่องานถูกส่งตรวจ ขณะแอปเปิด), **ล็อกอินจริงด้วย OTP อีเมล**, และ **RLS จริง** (พนักงานเห็นเฉพาะงานตัวเองระดับฐานข้อมูล)

> โค้ดชุดนี้ยังไม่ได้ทดสอบกับ Supabase จริง (ทำในสภาพแวดล้อมที่ไม่มี key) — ถือเป็น "โครงพร้อมคู่มือ" ควรทำ/ทดสอบทีละขั้นตามด้านล่าง

## ไฟล์ที่เกี่ยวข้อง
- `supabase-schema.sql` — สร้างตาราง + RLS + trigger + seed หัวหน้า
- `supabase-client.js` — ตัวเชื่อม (แทน Apps Script) ให้ interface เดิม
- `index.html` — ใส่ค่า `SUPABASE_URL` / `SUPABASE_ANON_KEY` แล้วสลับโหมดอัตโนมัติ

---

## ขั้นตอน

### 1) สร้างโปรเจกต์ Supabase
1. ไป supabase.com → New project (ฟรีทีเออร์) ตั้งรหัส database เก็บไว้
2. รอสร้างเสร็จ ~2 นาที

### 2) รัน SQL
1. เมนูซ้าย **SQL Editor → New query**
2. วางเนื้อหา `supabase-schema.sql` ทั้งไฟล์ → **Run**
3. แก้อีเมลหัวหน้าใน `insert ... app_users` ให้ตรงของคุณก่อนรัน (หรือแก้ทีหลังในตาราง)

### 3) เปิดล็อกอินด้วยอีเมล OTP
1. **Authentication → Providers → Email** → เปิด **Enable Email provider**
2. เปิด **Email OTP** (ส่งรหัส 6 หลัก) — ถ้าใช้ค่าเริ่มต้นจะเป็นลิงก์ ให้เลือกแบบ OTP/mail template ที่มี `{{ .Token }}`
3. (ทางเลือก) จำกัดเฉพาะโดเมนบริษัทได้ที่ Auth settings

### 4) เอา URL + anon key มาใส่
1. **Project Settings → API** → คัดลอก **Project URL** และ **anon public key**
2. เปิด `index.html` แก้ 2 บรรทัดบนสุด:
```js
window.SUPABASE_URL = "https://xxxxx.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGci...";  // anon public (ไม่ใช่ service_role)
```
> ใส่แล้วแอปจะใช้ Supabase อัตโนมัติ (ไม่ต้องลบ Apps Script URL) — ถ้าเว้นว่างจะกลับไปใช้ Apps Script

### 5) ย้ายข้อมูลจาก Google Sheet (ถ้ามีของเดิม)
1. ในชีต export แต่ละแท็บเป็น CSV
2. Supabase → **Table Editor → เลือกตาราง → Insert → Import from CSV**
   - `Users` → `app_users` (map: Name→name, Role→role, Email→email, IsBoss `TRUE`→true, Active)
   - `Tasks` → `tasks` (แปลง DueDate `dd/mm/yyyy`→`yyyy-mm-dd`; AssigneeID เดิม (U1..) ต้อง map เป็น id ใหม่ของ app_users)
   - Comments/DueLog ตามลำดับ
3. ถ้า map id ยาก แนะนำเริ่มข้อมูลใหม่ (สร้างสมาชิก+งานใหม่ในแอป) จะง่ายกว่า เพราะ id เปลี่ยนเป็น uuid

### 6) Deploy + ทดสอบ
1. push `index.html`, `supabase-client.js` ขึ้น GitHub (`supabase-schema.sql`/README เก็บไว้เฉยๆ)
2. เปิดแอป → กรอกอีเมล → รับรหัสในเมล → ยืนยัน → เข้าใช้งาน
3. ทดสอบ: หัวหน้าเห็นทุกงาน, พนักงานเห็นเฉพาะของตัวเอง, ลูกน้องส่งตรวจแล้วหัวหน้าเด้งเตือน (realtime)

---

## หมายเหตุ / จุดที่ต้องระวัง
- **ความปลอดภัยดีขึ้นจริง**: identity มาจาก session ของ Supabase (ยืนยันอีเมลแล้ว) + RLS บังคับที่ฐานข้อมูล → ปิดช่องโหว่ "กรอกอีเมลใครก็ได้" ของเวอร์ชัน Apps Script
- **anon key เปิดเผยได้** (ปลอดภัยเพราะมี RLS) — ห้ามใส่ `service_role` key ในหน้าเว็บเด็ดขาด
- **Realtime เด้งเฉพาะตอนแอปเปิด** เหมือนเดิม — อยากเด้งตอนปิดแอปต้องเพิ่ม Web Push/LINE
- **รูปโปรไฟล์** เก็บเป็น base64 ในคอลัมน์ `photo` เหมือนเดิม (ถ้าต้องการ ใช้ Supabase Storage แทนได้ภายหลัง เพื่อลดขนาด row)
- ยังไม่ได้ทดสอบจริง — ถ้าเจอ error ให้ดู Console ของเบราว์เซอร์ + Logs ใน Supabase แล้วบอกผมมา จะช่วยไล่แก้ต่อ
