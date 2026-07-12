# ตามงาน — PWA บริหารและติดตามงานของทีม

เว็บแอปติดตามงานของทีม (Manager / Member) เก็บข้อมูลบน **Google Sheet** ผ่าน **Google Apps Script (JSON API)**
หน้าเว็บเป็น **PWA** วางบน **GitHub Pages** ติดตั้งลงหน้าจอมือถือ/คอมได้

## โครงสร้างไฟล์

| ไฟล์ | หน้าที่ |
|------|---------|
| `index.html` | ตัวแอปทั้งหมด (UI + logic) — static |
| `code.js` | โค้ด Google Apps Script (backend API) — วางในโปรเจกต์ Apps Script |
| `manifest.webmanifest` | ข้อมูล PWA (ชื่อ, ไอคอน, สี) |
| `sw.js` | Service Worker (แคช/ออฟไลน์) |
| `icon.svg` | ไอคอนแอป |
| `.github/workflows/deploy-pages.yml` | Deploy ขึ้น GitHub Pages อัตโนมัติ |

---

## ขั้นตอนติดตั้ง

### 1) ตั้ง Backend (Apps Script API)
1. เปิด Google Sheet ที่ใช้เก็บข้อมูล → เมนู **Extensions → Apps Script**
2. วางเนื้อหาไฟล์ `code.js` ลงในไฟล์ `Code.gs` (แทนของเดิม)
3. แก้อีเมลหัวหน้าทีมบนสุด: `const ADMIN_EMAILS = ['lewclassic@gmail.com'];`
4. **Deploy → New deployment → Web app**
   - **Execute as:** Me
   - **Who has access:** **Anyone**
5. คัดลอก **Web app URL** (ลงท้าย `/exec`)

> ทุกครั้งที่แก้ `code.js` ต้อง **Deploy → Manage deployments → Edit → Version: New version**

### 2) ใส่ URL ในหน้าเว็บ
เปิด `index.html` แก้บรรทัดเดียว (อยู่บนสุดของไฟล์):
```html
window.TAMNGAN_API_URL = "https://script.google.com/macros/s/XXXXX/exec";
```

### 3) ขึ้น GitHub Pages
1. สร้าง repo ใหม่บน GitHub แล้วอัปโหลดไฟล์ทั้งหมด (ยกเว้น `code.js` จะอัปด้วยก็ได้ ไม่ถูกใช้ตอนรัน)
2. **Settings → Pages**
   - ถ้าใช้ workflow ที่ให้มา: เลือก **Source: GitHub Actions** (push ขึ้น `main` แล้ว deploy เอง)
   - หรือแบบง่าย: **Source: Deploy from a branch → main → /(root)**
3. เปิด URL ที่ได้ (เช่น `https://<user>.github.io/<repo>/`)

### 4) ติดตั้งลงหน้าจอ (PWA)
- **Android/Chrome, Desktop Chrome/Edge:** เปิดเว็บ → เมนู → “ติดตั้งแอป / Install”
- **iPhone/Safari:** ปุ่มแชร์ → “เพิ่มไปยังหน้าจอโฮม”

---

## หมายเหตุสำคัญ (ตรงไปตรงมา)
- **CORS:** โค้ดเรียก API แบบ POST โดยไม่ตั้ง Content-Type (เลี่ยง preflight) ซึ่งเป็นวิธีมาตรฐานที่ใช้ได้กับ Apps Script Web App (Anyone) — ถ้าเจอปัญหาโหลดข้อมูลไม่ขึ้น ให้เช็คว่า deploy เป็น **Anyone** และใช้ URL `/exec` (ไม่ใช่ `/dev`)
- **ล็อกอิน:** เป็นแบบกรอกอีเมล (ไม่มีรหัสผ่าน) เหมาะกับทีมภายในที่ไว้ใจกัน ใครกรอกอีเมลหัวหน้าก็ได้สิทธิ์หัวหน้า ถ้าต้องการความปลอดภัยจริงต้องต่อ Google Sign-In/OAuth เพิ่ม
- **ไอคอน:** ใช้ `icon.svg` (Android/Desktop รองรับ) ถ้าต้องการให้คมสุดบน iOS แนะนำเพิ่มไฟล์ PNG `icon-192.png` / `icon-512.png` แล้วเพิ่มใน `manifest.webmanifest`
- **ออฟไลน์:** แคชเฉพาะหน้าแอป (shell) ข้อมูลงานยังต้องต่อเน็ตเพื่อดึงจาก Sheet
- ไฟล์เดียวกันนี้ยังเปิดในโหมด Apps Script (google.script.run) หรือเปิดไฟล์เปล่าเป็น preview ได้ — โค้ดเลือก transport อัตโนมัติ
