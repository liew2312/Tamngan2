/* =====================================================================
   ตามงาน — ตัวเชื่อม Supabase (data layer)
   ให้ contract เดียวกับ callServer(action, args) ที่แอปใช้อยู่
   ต้องโหลด @supabase/supabase-js ก่อนไฟล์นี้ (ดู index.html)
   ตั้งค่า window.SUPABASE_URL และ window.SUPABASE_ANON_KEY
   ===================================================================== */
(function () {
  const URL = (window.SUPABASE_URL || '').trim();
  const KEY = (window.SUPABASE_ANON_KEY || '').trim();
  const SB = { ready: false, client: null, me: null };
  window.SB = SB;

  if (!URL || !KEY || !window.supabase) return; // ยังไม่ตั้งค่า → แอปจะ fallback ไป Apps Script/preview
  SB.client = window.supabase.createClient(URL, KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  SB.ready = true;

  /* ---------- แปลงรูปแบบข้อมูล DB <-> หน้าเว็บ ---------- */
  const pad = n => String(n).padStart(2, '0');
  function dbToDMY(d) { if (!d) return ''; const p = String(d).slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : ''; }
  function dmyToDb(s) { if (!s) return null; const p = String(s).split('/'); return p.length === 3 ? `${p[2]}-${pad(p[1])}-${pad(p[0])}` : null; }
  function uUser(r) { return { UserID: r.id, Name: r.name, Role: r.role, Email: r.email || '', Color: r.color, IsBoss: r.is_boss ? 'TRUE' : '', Photo: r.photo || '', Status: r.status || '', Active: r.active === false ? 'FALSE' : 'TRUE', LastLogin: r.last_login || '' }; }
  function uTask(r) { return { TaskID: r.id, Project: r.project || '', Title: r.title || '', Description: r.description || '', AssigneeID: r.assignee || '', DueDate: dbToDMY(r.due_date), Status: r.status || 'ยังไม่เริ่ม', Progress: parseInt(r.progress) || 0, Priority: r.priority || 'ปกติ', CompletedAt: r.completed_at || '', comments: [], dueLog: [] }; }

  /* ---------- Auth (อีเมล: กดลิงก์ หรือกรอกรหัส) ---------- */
  SB.appUrl = location.origin + location.pathname; // ปลายทางให้ magic link เด้งกลับ
  SB.sendOtp = (email) => SB.client.auth.signInWithOtp({ email: email, options: { shouldCreateUser: true, emailRedirectTo: SB.appUrl } });
  SB.verifyOtp = (email, token) => SB.client.auth.verifyOtp({ email: email, token: token, type: 'email' });
  SB.signInGoogle = () => SB.client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: SB.appUrl } });
  SB.signOut = () => SB.client.auth.signOut();
  SB.getSessionEmail = async () => {
    const { data } = await SB.client.auth.getSession();
    return (data && data.session && data.session.user && data.session.user.email) || '';
  };
  // ฟัง auth event (INITIAL_SESSION / SIGNED_IN / TOKEN_REFRESHED / SIGNED_OUT)
  SB.onAuth = (cb) => {
    try {
      SB.client.auth.onAuthStateChange((event, session) =>
        cb(event, (session && session.user && session.user.email) || ''));
    } catch (e) {}
  };

  /* ---------- โหลดข้อมูลทั้งหมด (RLS กรองให้เองตามสิทธิ์) ---------- */
  async function fetchAll() {
    const email = (await SB.getSessionEmail()).toLowerCase();
    const [u, t, c, d] = await Promise.all([
      SB.client.from('app_users').select('*'),
      SB.client.from('tasks').select('*'),
      SB.client.from('comments').select('*'),
      SB.client.from('due_log').select('*')
    ]);
    if (u.error) throw u.error; if (t.error) throw t.error;
    const users = (u.data || []).map(uUser);
    const nameMap = {}; (u.data || []).forEach(r => nameMap[r.id] = r.name);
    const tasks = (t.data || []).map(uTask);
    tasks.forEach(tk => { tk.AssigneeName = nameMap[tk.AssigneeID] || ''; });
    (c.data || []).forEach(cm => {
      const tk = tasks.find(x => x.TaskID === cm.task_id);
      if (tk) tk.comments.push({ UserID: cm.author, Name: nameMap[cm.author] || '', Message: cm.message, Timestamp: cm.created_at });
    });
    (d.data || []).forEach(dl => {
      const tk = tasks.find(x => x.TaskID === dl.task_id);
      if (tk) tk.dueLog.push({ OldDate: dl.old_date, NewDate: dl.new_date, Reason: dl.reason, ByName: dl.by_name, Timestamp: dl.created_at });
    });
    const meRow = (u.data || []).find(r => (r.email || '').toLowerCase() === email);
    SB.me = meRow ? uUser(meRow) : null;
    const currentUser = meRow
      ? { UserID: meRow.id, Name: meRow.name, Role: meRow.role, Email: meRow.email, Photo: meRow.photo || '', Status: meRow.status || '', active: meRow.active !== false, isBoss: !!meRow.is_boss, registered: true }
      : { UserID: null, Name: email, Email: email, isBoss: false, registered: false };
    return { users, tasks, currentUser };
  }

  async function meId() {
    if (SB.me && SB.me.UserID) return SB.me.UserID;
    const email = (await SB.getSessionEmail()).toLowerCase();
    const { data } = await SB.client.from('app_users').select('id,name,is_boss').eq('email', email).limit(1);
    if (data && data[0]) { SB.me = { UserID: data[0].id, Name: data[0].name, IsBoss: data[0].is_boss ? 'TRUE' : '' }; return data[0].id; }
    throw new Error('บัญชีของคุณยังไม่ได้ลงทะเบียนในระบบ');
  }
  const USER_COLORS = ['#5b82e0', '#e8536e', '#e8942f', '#22a97a', '#a06ddb', '#3fa9c4', '#e07b9a'];

  /* ---------- ตัวจัดการ action (args[0] = อีเมลจาก srv, ไม่ใช้ในโหมดนี้) ---------- */
  const H = {
    fetchAppData: () => fetchAll(),

    addUser: async (a) => {
      const rec = { name: a[0], role: a[1] || 'ทีมงาน', email: (a[2] || '').toLowerCase() || null, is_boss: false, active: true, color: USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)] };
      const { data, error } = await SB.client.from('app_users').insert(rec).select().single();
      if (error) throw error; const o = uUser(data); o.tasks = []; return o;
    },
    updateMember: async (a) => {
      const patch = { name: a[1], role: a[2] || 'ทีมงาน', email: (a[3] || '').toLowerCase() || null, is_boss: !!a[4], active: !!a[5] };
      const { data, error } = await SB.client.from('app_users').update(patch).eq('id', a[0]).select().single();
      if (error) throw error; return uUser(data);
    },
    deleteMember: async (a) => {
      const { count } = await SB.client.from('tasks').select('id', { count: 'exact', head: true }).eq('assignee', a[0]);
      if (count && count > 0) throw new Error('ลบไม่ได้ ยังมีงานอยู่ ' + count + ' งาน — ย้ายผู้รับผิดชอบหรือลบงานก่อน (หรือปิดการใช้งานแทน)');
      const { error } = await SB.client.from('app_users').delete().eq('id', a[0]);
      if (error) throw error; return true;
    },
    updateProfile: async (a) => {
      const id = await meId();
      const { error } = await SB.client.from('app_users').update({ photo: a[0] || '', status: a[1] || '' }).eq('id', id);
      if (error) throw error; return { UserID: id, Photo: a[0] || '', Status: a[1] || '' };
    },

    addTask: async (a) => {
      const rec = { project: a[0], title: a[1], description: a[2] || '', assignee: a[3] || null, due_date: dmyToDb(a[4]), status: a[5] || 'ยังไม่เริ่ม', priority: a[6] || 'ปกติ', progress: a[5] === 'เสร็จแล้ว' ? 100 : 0 };
      const { data, error } = await SB.client.from('tasks').insert(rec).select().single();
      if (error) throw error; const o = uTask(data); o.AssigneeName = ''; return o;
    },
    updateTask: async (a) => {
      const taskId = a[0], reason = a[8];
      const { data: cur } = await SB.client.from('tasks').select('*').eq('id', taskId).single();
      const newDb = dmyToDb(a[5]);
      if (cur && newDb && newDb !== cur.due_date) {
        await SB.client.from('due_log').insert({ task_id: taskId, old_date: dbToDMY(cur.due_date), new_date: a[5], reason: reason || '', by_user: (SB.me && SB.me.UserID) || null, by_name: (SB.me && SB.me.Name) || '' });
      }
      const patch = { project: a[1], title: a[2], description: a[3] || '', assignee: a[4] || null, due_date: newDb, status: a[6] || 'ยังไม่เริ่ม', priority: a[7] || 'ปกติ' };
      if (a[6] === 'เสร็จแล้ว') patch.progress = 100; else if (cur && cur.progress >= 100) patch.progress = 90;
      const { data, error } = await SB.client.from('tasks').update(patch).eq('id', taskId).select().single();
      if (error) throw error; return uTask(data);
    },
    deleteTask: async (a) => { const { error } = await SB.client.from('tasks').delete().eq('id', a[0]); if (error) throw error; return true; },
    updateProgress: async (a) => { const { error } = await SB.client.from('tasks').update({ progress: parseInt(a[1]) || 0 }).eq('id', a[0]); if (error) throw error; return true; },
    setStatus: async (a) => {
      const patch = { status: a[1] };
      if (a[1] === 'เสร็จแล้ว') patch.progress = 100;
      const { data, error } = await SB.client.from('tasks').update(patch).eq('id', a[0]).select().single();
      if (error) throw error; return { TaskID: a[0], Status: data.status, Progress: data.progress, CompletedAt: data.completed_at || '' };
    },
    setTaskDone: async (a) => {
      const patch = a[1] ? { status: 'เสร็จแล้ว', progress: 100 } : { status: 'กำลังทำ', progress: 50 };
      const { data, error } = await SB.client.from('tasks').update(patch).eq('id', a[0]).select().single();
      if (error) throw error; return { TaskID: a[0], Status: data.status, Progress: data.progress, CompletedAt: data.completed_at || '' };
    },
    saveComment: async (a) => {
      const id = await meId();
      const { data, error } = await SB.client.from('comments').insert({ task_id: a[0], author: id, message: a[1] }).select().single();
      if (error) throw error; return { UserID: id, Name: (SB.me && SB.me.Name) || '', Message: a[1], Timestamp: data.created_at };
    },
    touchActive: async () => {
      try { const id = await meId(); await SB.client.from('app_users').update({ last_login: new Date().toISOString() }).eq('id', id); } catch (e) {}
      return true;
    },

    /* ---------- To-do ส่วนตัว (ตาราง todos — RLS เห็นเฉพาะของตัวเอง) ---------- */
    listTodos: async () => {
      const id = await meId();
      const { data, error } = await SB.client.from('todos').select('*').eq('owner', id).order('created_at');
      if (error) throw error;
      return (data || []).map(uTodo);
    },
    addTodo: async (a) => {
      const id = await meId(); const t = a[0] || {};
      const { data, error } = await SB.client.from('todos')
        .insert({ owner: id, text: t.text, tag: t.tag || null, priority: t.priority || 'ปกติ', date: dmyToDb(t.date), done: !!t.done })
        .select().single();
      if (error) throw error;
      return uTodo(data);
    },
    updateTodo: async (a) => {
      const t = a[1] || {};
      const { error } = await SB.client.from('todos')
        .update({ text: t.text, tag: t.tag || null, priority: t.priority || 'ปกติ', date: dmyToDb(t.date), done: !!t.done })
        .eq('id', a[0]);
      if (error) throw error; return true;
    },
    deleteTodo: async (a) => {
      const { error } = await SB.client.from('todos').delete().eq('id', a[0]);
      if (error) throw error; return true;
    }
  };
  function uTodo(r) { return { id: r.id, text: r.text || '', tag: r.tag || '', priority: r.priority || 'ปกติ', date: dbToDMY(r.date), done: !!r.done }; }

  // srv() แนบ sessionEmail เป็น args[0] → ตัดทิ้ง (identity มาจาก session จริง)
  SB.call = function (action, args) {
    args = args || [];
    if (action === 'fetchAppData') return H.fetchAppData();
    const a = args.slice(1);
    if (!H[action]) return Promise.reject(new Error('ไม่รู้จักคำสั่ง: ' + action));
    return H[action](a);
  };

  // Realtime: มีการเปลี่ยนแปลงตาราง tasks → เรียก callback
  SB.subscribe = function (cb) {
    try {
      SB.client.channel('tasks-rt')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, cb)
        .subscribe();
    } catch (e) {}
  };
})();
