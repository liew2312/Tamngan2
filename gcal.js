/* =====================================================================
   ตามงาน — เชื่อม Google Calendar (ทางเดียว: แอป → ปฏิทินของแต่ละคน)

   หลักการ
   - ใช้ Google Identity Services (GIS) ขอ access token ในเบราว์เซอร์
     ไม่ต้องมี backend ไม่ต้องเก็บ client secret ไม่ต้องเก็บ token ใน DB
   - event id คำนวณจาก TaskID โดยตรง (tn + uuid ที่ตัดขีดออก)
     → ซิงก์ซ้ำกี่รอบก็ไม่เกิดอีเวนต์ซ้ำ ไม่ต้องเพิ่มคอลัมน์ในฐานข้อมูล
   - เก็บ "ลายเซ็น" ของงานแต่ละชิ้นไว้ใน localStorage
     → รอบถัดไปงานไหนไม่เปลี่ยนก็ข้าม ไม่ยิง API ซ้ำ

   ตั้งค่า: window.GOOGLE_CLIENT_ID ใน index.html (ดู README-gcal.md)
   ===================================================================== */
(function () {
  const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
  const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  const K_ON = 'gcal_on';
  const K_MAP = 'gcal_map';
  const K_LAST = 'gcal_last';

  const G = {
    clientId: (window.GOOGLE_CLIENT_ID || '').trim(),
    token: null, tokenExp: 0, tokenClient: null, syncing: false, timer: null
  };
  window.GCAL = G;

  /* ---------- เก็บสถานะ ---------- */
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  function getMap() { try { return JSON.parse(ls.get(K_MAP, '{}')) || {}; } catch (e) { return {}; } }
  function setMap(m) { ls.set(K_MAP, JSON.stringify(m)); }

  G.available = () => !!G.clientId;
  G.isEnabled = () => ls.get(K_ON, '') === '1';
  G.lastSync = () => ls.get(K_LAST, '');
  G.lastSyncText = () => {
    const t = G.lastSync(); if (!t) return 'ยังไม่เคยซิงก์';
    const d = new Date(t); if (isNaN(d)) return 'ยังไม่เคยซิงก์';
    return 'ซิงก์ล่าสุด ' + d.toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  /* ---------- token ---------- */
  function gisReady() { return !!(window.google && google.accounts && google.accounts.oauth2); }

  function ensureClient() {
    if (G.tokenClient || !gisReady() || !G.clientId) return G.tokenClient;
    G.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: G.clientId, scope: SCOPE, callback: () => {}
    });
    return G.tokenClient;
  }

  // prompt: '' = เงียบ (ต้องเคยอนุญาตแล้ว), 'consent' = เปิดหน้าต่างให้เลือกบัญชี
  function getToken(prompt, hintEmail) {
    return new Promise((resolve, reject) => {
      if (G.token && Date.now() < G.tokenExp - 60000) return resolve(G.token);
      const c = ensureClient();
      if (!c) return reject(new Error('ยังโหลด Google Identity Services ไม่เสร็จ — ลองใหม่อีกครั้ง'));
      c.callback = (resp) => {
        if (resp && resp.access_token) {
          G.token = resp.access_token;
          G.tokenExp = Date.now() + ((resp.expires_in || 3600) * 1000);
          resolve(G.token);
        } else {
          reject(new Error((resp && resp.error_description) || 'ขอสิทธิ์ปฏิทินไม่สำเร็จ'));
        }
      };
      c.error_callback = (err) => reject(new Error((err && err.type) === 'popup_closed'
        ? 'ปิดหน้าต่างขออนุญาตก่อนเสร็จ' : ((err && err.message) || 'ขอสิทธิ์ปฏิทินไม่สำเร็จ')));
      try { c.requestAccessToken(hintEmail ? { prompt: prompt, hint: hintEmail } : { prompt: prompt }); }
      catch (e) { reject(e); }
    });
  }

  /* ---------- แปลงข้อมูลงาน → อีเวนต์ ---------- */
  const pad = n => String(n).padStart(2, '0');
  function dmyToISO(s) {
    if (!s) return '';
    const p = String(s).split('/');
    return p.length === 3 ? `${p[2]}-${pad(p[1])}-${pad(p[0])}` : '';
  }
  function nextDay(iso) {
    const d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  // Google ยอมรับ event id เฉพาะ a-v และ 0-9 — uuid เป็น hex (0-9a-f) จึงใช้ได้เลย
  function eventId(taskId) { return 'tn' + String(taskId).replace(/[^0-9a-f]/gi, '').toLowerCase(); }

  const PRIO_COLOR = { 'สูง': '11', 'ต่ำ': '8' };   // 11=แดง 8=เทา อื่นๆ=สีเริ่มต้น
  function buildEvent(t) {
    const iso = dmyToISO(t.DueDate);
    const done = t.Status === 'เสร็จแล้ว';
    const appUrl = location.origin + location.pathname;
    const body = {
      id: eventId(t.TaskID),
      summary: (done ? '✅ ' : '') + (t.Project ? '[' + t.Project + '] ' : '') + (t.Title || 'งาน'),
      description: [
        t.Description || '',
        '',
        'สถานะ: ' + (t.Status || '-') + ' · ความสำคัญ: ' + (t.Priority || 'ปกติ') + ' · คืบหน้า ' + (t.Progress || 0) + '%',
        'เปิดในแอปตามงาน: ' + appUrl
      ].join('\n').trim(),
      start: { date: iso },
      end: { date: nextDay(iso) },
      source: { title: 'ตามงาน', url: appUrl },
      transparency: 'transparent',          // ไม่ทำให้ปฏิทินขึ้นว่า "ไม่ว่าง"
      extendedProperties: { private: { tamngan: '1', taskId: String(t.TaskID) } }
    };
    const c = PRIO_COLOR[t.Priority];
    if (c) body.colorId = c;
    return body;
  }
  // ลายเซ็น — เปลี่ยนเมื่อไหร่ค่อยยิง API ใหม่
  function sigOf(t) {
    return [t.Title, t.Project, t.Description, t.DueDate, t.Status, t.Priority, t.Progress].join('|');
  }

  /* ---------- เรียก Google API ---------- */
  async function call(method, path, body) {
    const res = await fetch(API + (path || ''), {
      method: method,
      headers: { 'Authorization': 'Bearer ' + G.token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) { G.token = null; G.tokenExp = 0; throw Object.assign(new Error('token หมดอายุ'), { code: 401 }); }
    if (res.status === 204 || res.status === 404 || res.status === 410) return { status: res.status };
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data.error && data.error.message) || ('HTTP ' + res.status);
      throw Object.assign(new Error(msg), { code: res.status });
    }
    return { status: res.status, data: data };
  }

  async function upsert(t) {
    const ev = buildEvent(t);
    try {
      const r = await call('PUT', '/' + ev.id, ev);
      if (r.status === 404 || r.status === 410) throw Object.assign(new Error('not found'), { code: 404 });
      return true;
    } catch (e) {
      if (e.code === 404 || e.code === 410) {
        await call('POST', '', ev);        // ยังไม่มี → สร้างใหม่ด้วย id เดิม
        return true;
      }
      if (e.code === 409) { await call('PUT', '/' + ev.id, ev); return true; }  // มีอยู่แล้ว → อัปเดต
      throw e;
    }
  }
  async function remove(taskId) {
    try { await call('DELETE', '/' + eventId(taskId)); } catch (e) { if (e.code !== 404 && e.code !== 410) throw e; }
  }

  /* ---------- ซิงก์ ---------- */
  //  งานที่เข้าปฏิทิน = งานของ "ฉัน" ที่มีกำหนดส่ง และยังไม่ถูกยกเลิก
  function mine(tasks, myId) {
    return (tasks || []).filter(t => t.AssigneeID === myId);
  }
  function shouldHaveEvent(t) {
    return !!dmyToISO(t.DueDate) && t.Status !== 'ยกเลิก';
  }

  G.sync = async function (tasks, myId, opts) {
    opts = opts || {};
    if (!G.available() || !myId) return { skipped: true };
    if (G.syncing) return { skipped: true };
    G.syncing = true;
    const result = { added: 0, removed: 0, failed: 0, errors: [] };
    try {
      await getToken(opts.interactive ? 'consent' : '', opts.email);
      const list = mine(tasks, myId);
      const map = getMap();
      const seen = {};
      const jobs = [];

      list.forEach(t => {
        seen[t.TaskID] = 1;
        const want = shouldHaveEvent(t);
        const sig = want ? sigOf(t) : null;
        if (want) {
          if (map[t.TaskID] !== sig || opts.force) jobs.push({ kind: 'up', t: t, sig: sig });
        } else if (map[t.TaskID]) {
          jobs.push({ kind: 'del', id: t.TaskID });
        }
      });
      // งานที่หายไปจากระบบแล้ว (ถูกลบ / ย้ายผู้รับผิดชอบ) → เอาออกจากปฏิทิน
      Object.keys(map).forEach(id => { if (!seen[id]) jobs.push({ kind: 'del', id: id }); });

      // ทำทีละ 4 งานพร้อมกัน กันโดน rate limit
      for (let i = 0; i < jobs.length; i += 4) {
        await Promise.all(jobs.slice(i, i + 4).map(async j => {
          try {
            if (j.kind === 'up') { await upsert(j.t); map[j.t.TaskID] = j.sig; result.added++; }
            else { await remove(j.id); delete map[j.id]; result.removed++; }
          } catch (e) {
            result.failed++;
            if (result.errors.length < 3) result.errors.push(e.message || String(e));
          }
        }));
      }
      setMap(map);
      ls.set(K_LAST, new Date().toISOString());
      return result;
    } finally {
      G.syncing = false;
    }
  };

  // เรียกได้บ่อยๆ — หน่วง 2.5 วิ และทำเฉพาะตอนเปิดใช้งานไว้
  G.autoSync = function (tasks, myId, email) {
    if (!G.available() || !G.isEnabled() || !myId) return;
    clearTimeout(G.timer);
    G.timer = setTimeout(() => {
      G.sync(tasks, myId, { email: email }).catch(() => {
        /* เงียบไว้ — ถ้า token หมดอายุจริง ผู้ใช้จะเห็นสถานะในเมนู "เพิ่มเติม" */
      });
    }, 2500);
  };

  G.connect = async function (email) {
    if (!G.available()) throw new Error('ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID ใน index.html');
    await getToken('consent', email);
    ls.set(K_ON, '1');
    return true;
  };

  G.disconnect = function () {
    ls.set(K_ON, '0');
    ls.del(K_MAP);
    ls.del(K_LAST);
    try { if (G.token && gisReady()) google.accounts.oauth2.revoke(G.token, () => {}); } catch (e) {}
    G.token = null; G.tokenExp = 0;
  };

  // ลบอีเวนต์ทั้งหมดที่แอปเคยสร้าง (ใช้ตอนเลิกใช้แล้วอยากเก็บกวาดปฏิทิน)
  G.purge = async function (email) {
    await getToken('', email);
    const map = getMap();
    const ids = Object.keys(map);
    for (let i = 0; i < ids.length; i += 4) {
      await Promise.all(ids.slice(i, i + 4).map(id => remove(id).catch(() => {})));
    }
    setMap({});
    return ids.length;
  };
})();
