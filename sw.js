/* Service Worker สำหรับ PWA "ตามงาน"
   - HTML: network-first (ได้เวอร์ชันใหม่เสมอเมื่อออนไลน์ กันปัญหาหน้าเก่าค้าง)
   - ไฟล์ static (icon/manifest): stale-while-revalidate (อัปเดตเงียบๆ เบื้องหลัง)
   - ไม่แคชการเรียก API ของ Google (Apps Script) */
const CACHE = 'tamngan-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  // ปล่อยผ่าน: ไม่ใช่ GET หรือเป็น API ของ Google (Apps Script)
  if (req.method !== 'GET' || /google|gstatic/.test(url.hostname)) return;

  // HTML / การนำทาง → network-first
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put('./index.html', c)); return r; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // static ของเราเอง → stale-while-revalidate
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(cached => {
        const net = fetch(req).then(r => {
          if (r && r.status === 200) { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
          return r;
        }).catch(() => cached);
        return cached || net;
      })
    );
    return;
  }

  // ข้ามโดเมน (ฟอนต์/ไอคอน CDN) → cache-first
  e.respondWith(caches.match(req).then(c => c || fetch(req)));
});
