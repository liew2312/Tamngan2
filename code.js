// ======================================================
//  ตั้งค่า (แก้ไขได้)
// ======================================================
// อีเมลของ "หัวหน้าทีม" ที่มีสิทธิ์เพิ่มลูกน้อง/มอบหมายงาน/ลบงาน
// ใส่ได้หลายคน คั่นด้วยจุลภาค เช่น ['a@apthai.com','b@apthai.com']
const ADMIN_EMAILS = ['lewclassic@gmail.com'];

// เปิดให้พนักงานในองค์กรที่เปิดแอปครั้งแรก ถูกเพิ่มเป็นสมาชิกอัตโนมัติ
// (ถ้าปิด = เฉพาะคนที่มีอีเมลอยู่ในชีต Users เท่านั้นที่ใช้งานได้)
const AUTO_REGISTER = true;

// คอลัมน์มาตรฐานของชีต Users
const USER_HEADERS = ['UserID', 'Name', 'Role', 'Email', 'Color', 'IsBoss', 'Photo', 'Status', 'Active'];
const USER_COLORS = ['#5b82e0', '#e8536e', '#e8942f', '#22a97a', '#a06ddb', '#3fa9c4', '#e07b9a'];

// ======================================================
//  Web App เป็น JSON API (สำหรับ PWA บน GitHub Pages เรียกผ่าน fetch)
//  Deploy: Deploy > New deployment > Web app
//    Execute as: Me   |   Who has access: Anyone
//  แล้วนำ URL (.../exec) ไปใส่ใน index.html (ค่า API_URL)
// ======================================================

// รายชื่อฟังก์ชันที่เรียกจากหน้าเว็บได้ (whitelist)
function apiDispatch_(action, args) {
  const PUBLIC = {
    loginWithEmail: loginWithEmail,
    fetchAppData: fetchAppData,
    addUser: addUser,
    addTask: addTask,
    updateTask: updateTask,
    deleteTask: deleteTask,
    deleteMember: deleteMember,
    updateMember: updateMember,
    updateProfile: updateProfile,
    updateProgress: updateProgress,
    saveComment: saveComment,
    setStatus: setStatus,
    setTaskDone: setTaskDone
  };
  if (!PUBLIC[action]) throw new Error('ไม่รู้จักคำสั่ง: ' + action);
  // args คือชุดเดียวกับที่ google.script.run รับ (รวม actorEmail เป็นตัวแรกแล้วถ้าจำเป็น)
  return PUBLIC[action].apply(null, args || []);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    if (e && e.parameter && e.parameter.action) {
      const args = e.parameter.args ? JSON.parse(e.parameter.args) : [];
      return json_({ result: apiDispatch_(e.parameter.action, args) });
    }
    return json_({ ok: true, service: 'ตามงาน API' });
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    const body = (e && e.postData && e.postData.contents) ? JSON.parse(e.postData.contents) : {};
    return json_({ result: apiDispatch_(body.action, body.args || []) });
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

// ======================================================
//  ตรวจ/สร้างฐานข้อมูลอัตโนมัติ (+ อัปเกรดคอลัมน์เดิม)
// ======================================================
function checkAndSetupDatabase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Users
  let sUsers = ss.getSheetByName('Users');
  if (!sUsers) {
    sUsers = ss.insertSheet('Users');
    sUsers.appendRow(USER_HEADERS);
    // UserID, Name, Role, Email, Color, IsBoss, Photo, Status, Active
    sUsers.appendRow(['U1', 'มุก',  'Project Coordinator', '', '#5b82e0', '', '', '', 'TRUE']);
    sUsers.appendRow(['U2', 'พลอย', 'Sales Admin',         '', '#e8536e', '', '', '', 'TRUE']);
    sUsers.appendRow(['U3', 'เจมส์', 'Site Engineer',       '', '#e8942f', '', '', '', 'TRUE']);
  }
  ensureUserColumns_(sUsers); // เผื่อชีตเดิมยังไม่มีคอลัมน์ใหม่

  // 2. Tasks
  let sTasks = ss.getSheetByName('Tasks');
  if (!sTasks) {
    sTasks = ss.insertSheet('Tasks');
    sTasks.appendRow(['TaskID', 'Project', 'Title', 'Description', 'AssigneeID', 'DueDate', 'Status', 'Progress', 'Priority', 'CompletedAt']);
    const today = new Date();
    const fDate = (d) => Utilities.formatDate(d, "GMT+7", "dd/MM/yyyy");
    let d1 = new Date(today); d1.setDate(d1.getDate() + 1);
    let d2 = new Date(today); d2.setDate(d2.getDate() - 2);
    sTasks.appendRow(['T1', 'The City Sukkawat 3', 'ตรวจแบบห้องตัวอย่าง', 'ตรวจความเรียบร้อย ถ่ายรูปจุดที่ต้องแก้ให้ช่าง', 'U1', fDate(d1), 'กำลังทำ', 60, 'สูง']);
    sTasks.appendRow(['T2', 'Centro', 'สรุปยอดอัปเดตสัปดาห์', '', 'U1', fDate(today), 'ยังไม่เริ่ม', 30, 'ปกติ']);
    sTasks.appendRow(['T3', 'Centro', 'ส่งเอกสารโอนกรรมสิทธิ์', 'เช็คเอกสารกับฝ่ายขาย', 'U1', fDate(d2), 'กำลังทำ', 0, 'สูง']);
    sTasks.appendRow(['T4', 'The City Sukkawat 3', 'ตรวจเช็คสต็อกวัสดุ', 'เช็คยอดกระเบื้องกับผู้รับเหมา', 'U3', fDate(d1), 'กำลังทำ', 60, 'ปกติ']);
  }
  ensureTaskColumns_(sTasks); // เผื่อชีตเดิมยังไม่มี Priority

  // 3. Comments
  let sComments = ss.getSheetByName('Comments');
  if (!sComments) {
    sComments = ss.insertSheet('Comments');
    sComments.appendRow(['TaskID', 'UserID', 'Message', 'Timestamp']);
    sComments.appendRow(['T1', 'U1', 'ตรวจงานเฟสแรกเสร็จแล้ว เจอปัญหาสีผนัง 2 จุด', new Date().toISOString()]);
  }

  // 4. DueLog (ประวัติการเลื่อนกำหนดส่ง)
  let sDue = ss.getSheetByName('DueLog');
  if (!sDue) {
    sDue = ss.insertSheet('DueLog');
    sDue.appendRow(['TaskID', 'OldDate', 'NewDate', 'Reason', 'ByUserID', 'ByName', 'Timestamp']);
  }
}

// เพิ่มคอลัมน์ที่ยังไม่มีให้ชีต Users เดิม (ไม่ลบข้อมูลเดิม)
function ensureUserColumns_(sheet) {
  ['Email', 'IsBoss', 'Photo', 'Status', 'Active'].forEach(h => {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
    if (headers.indexOf(h) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(h);
    }
  });
}

// เพิ่มคอลัมน์ Priority / CompletedAt ให้ชีต Tasks เดิม
function ensureTaskColumns_(sheet) {
  ['Priority', 'CompletedAt'].forEach(h => {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
    if (headers.indexOf(h) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(h);
    }
  });
}

// ======================================================
//  ตัวช่วยอ่านชีตเป็น JSON (อิงหัวคอลัมน์)
// ======================================================
function getSheetJson_(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return [];
  const data = sheet.getDataRange().getDisplayValues();
  if (data.length < 2) return [];
  const headers = data.shift();
  return data.map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
}

// ======================================================
//  ระบุตัวผู้ใช้จากอีเมล Google ที่ล็อกอิน
// ======================================================
function getEmail_() {
  try { return String(Session.getActiveUser().getEmail() || '').toLowerCase(); }
  catch (e) { return ''; }
}
function emailToName_(email) {
  if (!email) return 'ผู้เยี่ยมชม';
  return email.split('@')[0];
}
function isAdminEmail_(email) {
  return !!email && ADMIN_EMAILS.map(e => String(e).toLowerCase()).indexOf(email) !== -1;
}

// คืนข้อมูลผู้ใช้ปัจจุบัน + สิทธิ์ (auto-register ถ้าเปิดใช้)
// actorEmail = อีเมลที่ผู้ใช้ล็อกอินเข้ามา (ส่งมาจากหน้าเว็บ) ถ้าไม่มีจะลองใช้ Session
function resolveCurrentUser_(actorEmail) {
  checkAndSetupDatabase();
  const email = (actorEmail ? String(actorEmail).trim().toLowerCase() : '') || getEmail_();
  let users = getSheetJson_('Users');
  let me = email ? users.find(u => String(u.Email || '').toLowerCase() === email) : null;

  if (!me && email && AUTO_REGISTER) {
    me = addUserInternal_(emailToName_(email), 'ทีมงาน', email, false);
  }

  const boss = isAdminEmail_(email) || (me && String(me.IsBoss).toUpperCase() === 'TRUE');
  return {
    UserID: me ? me.UserID : null,
    Name: me ? me.Name : emailToName_(email),
    Role: me ? me.Role : '',
    Email: email,
    Photo: me ? (me.Photo || '') : '',
    Status: me ? (me.Status || '') : '',
    active: me ? (String(me.Active).toUpperCase() !== 'FALSE') : true,
    isBoss: !!boss,
    registered: !!me
  };
}

function requireBoss_(actorEmail) {
  const me = resolveCurrentUser_(actorEmail);
  if (!me.isBoss) throw new Error('เฉพาะหัวหน้าทีมเท่านั้นที่ทำรายการนี้ได้');
  return me;
}

// เข้าสู่ระบบด้วยอีเมล (Gmail) — คืนข้อมูลผู้ใช้ + สิทธิ์
function loginWithEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || e.indexOf('@') === -1) throw new Error('กรุณากรอกอีเมลให้ถูกต้อง');
  const me = resolveCurrentUser_(e);
  if (me.registered && !me.active && !me.isBoss) {
    throw new Error('บัญชีนี้ถูกปิดการใช้งาน กรุณาติดต่อหัวหน้าทีม');
  }
  if (!me.registered && !AUTO_REGISTER && !me.isBoss) {
    throw new Error('อีเมลนี้ยังไม่มีในระบบ กรุณาติดต่อหัวหน้าทีมให้เพิ่มอีเมลของคุณก่อน');
  }
  return me;
}

// ======================================================
//  ดึงข้อมูลทั้งหมดส่งให้หน้าเว็บ
// ======================================================
function fetchAppData(actorEmail) {
  const currentUser = resolveCurrentUser_(actorEmail); // เรียกก่อน เพื่อให้ auto-register ปรากฏในรายชื่อ

  let users = getSheetJson_('Users');
  let tasks = getSheetJson_('Tasks');
  const comments = getSheetJson_('Comments');

  const dueLog = getSheetJson_('DueLog');

  const nameMap = {};
  users.forEach(u => { nameMap[u.UserID] = u.Name; });
  comments.forEach(c => { c.Name = nameMap[c.UserID] || c.UserID; });

  tasks.forEach(t => {
    t.Progress = parseInt(t.Progress) || 0;
    t.AssigneeName = nameMap[t.AssigneeID] || '';
    t.Priority = t.Priority || 'ปกติ';
    t.comments = comments.filter(c => c.TaskID === t.TaskID);
    t.dueLog = dueLog.filter(d => d.TaskID === t.TaskID);
  });

  // ความเป็นส่วนตัว: พนักงาน (ไม่ใช่หัวหน้า) รับเฉพาะงานของตัวเอง และเห็นเฉพาะข้อมูลตัวเอง
  if (!currentUser.isBoss && currentUser.UserID) {
    tasks = tasks.filter(t => t.AssigneeID === currentUser.UserID);
    users = users.filter(u => u.UserID === currentUser.UserID);
  }

  return { users: users, tasks: tasks, currentUser: currentUser };
}

// ======================================================
//  ตัวช่วยฝั่ง Users
// ======================================================
function nextId_(sheet, prefix) {
  const last = sheet.getLastRow();
  if (last < 2) return prefix + '1';
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  let max = 0;
  ids.forEach(r => {
    const m = String(r[0]).match(/\d+/);
    if (m) max = Math.max(max, parseInt(m[0], 10));
  });
  return prefix + (max + 1);
}

// เพิ่มแถวลงชีต Users ตามลำดับหัวคอลัมน์จริง (รองรับชีตที่อัปเกรดคอลัมน์)
function appendUserRow_(obj) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Users');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const row = headers.map(h => (obj.hasOwnProperty(h) ? obj[h] : ''));
  sheet.appendRow(row);
}

// เพิ่มผู้ใช้ (ภายใน ไม่เช็คสิทธิ์ — ใช้ทั้ง auto-register และหัวหน้าเพิ่มเอง)
function addUserInternal_(name, role, email, isBoss) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Users');
  const newId = nextId_(sheet, 'U');
  const color = USER_COLORS[(sheet.getLastRow() - 1) % USER_COLORS.length];
  const rec = {
    UserID: newId, Name: name, Role: role || 'ทีมงาน',
    Email: (email || '').toLowerCase(), Color: color, IsBoss: isBoss ? 'TRUE' : '',
    Photo: '', Status: '', Active: 'TRUE'
  };
  appendUserRow_(rec);
  return rec;
}

// หาแถวของงานจาก TaskID แล้วตั้งค่าตามชื่อคอลัมน์
function setTaskFields_(taskId, fields) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Tasks');
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(String);
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === taskId) {
      Object.keys(fields).forEach(k => {
        const col = headers.indexOf(k);
        if (col > -1) sheet.getRange(i + 1, col + 1).setValue(fields[k]);
      });
      return true;
    }
  }
  return false;
}

// อ่านข้อมูลงานหนึ่งแถวเป็น object
function getTaskById_(taskId) {
  const tasks = getSheetJson_('Tasks');
  return tasks.find(t => t.TaskID === taskId) || null;
}

// หาแถวของผู้ใช้จาก UserID แล้วตั้งค่าตามชื่อคอลัมน์ (รองรับคอลัมน์ที่เพิ่มภายหลัง)
function setUserFields_(userId, fields) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Users');
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(String);
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === userId) {
      Object.keys(fields).forEach(k => {
        const col = headers.indexOf(k);
        if (col > -1) sheet.getRange(i + 1, col + 1).setValue(fields[k]);
      });
      return true;
    }
  }
  return false;
}

// ======================================================
//  ฟังก์ชันสาธารณะ (เรียกจากหน้าเว็บ)
// ======================================================

// เพิ่มลูกน้อง — เฉพาะหัวหน้า
function addUser(actorEmail, name, role, email) {
  requireBoss_(actorEmail);
  const u = addUserInternal_(name, role, email, false);
  u.tasks = [];
  return u;
}

// มอบหมายงาน — เฉพาะหัวหน้า
function addTask(actorEmail, project, title, description, assigneeId, dueDate, status, priority) {
  requireBoss_(actorEmail);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Tasks');
  const newId = nextId_(sheet, 'T');
  const progress = (status === 'เสร็จแล้ว') ? 100 : 0;
  const prio = priority || 'ปกติ';
  sheet.appendRow([newId, project, title, description || '', assigneeId, dueDate, status || 'ยังไม่เริ่ม', progress, prio]);

  let assigneeName = '';
  const users = getSheetJson_('Users');
  const u = users.find(x => x.UserID === assigneeId);
  if (u) assigneeName = u.Name;

  return {
    TaskID: newId, Project: project, Title: title, Description: description || '',
    AssigneeID: assigneeId, AssigneeName: assigneeName, DueDate: dueDate,
    Status: status || 'ยังไม่เริ่ม', Progress: progress, Priority: prio, comments: [], dueLog: []
  };
}

// แก้ไขงาน — เฉพาะหัวหน้า (ถ้าเปลี่ยนกำหนดส่งจะบันทึกประวัติพร้อมเหตุผล)
function updateTask(actorEmail, taskId, project, title, description, assigneeId, dueDate, status, priority, dueReason) {
  const me = requireBoss_(actorEmail);
  const cur = getTaskById_(taskId);
  if (!cur) throw new Error('ไม่พบงานนี้');

  // ถ้าเปลี่ยนวันกำหนดส่ง → บันทึกลง DueLog
  const oldDue = String(cur.DueDate || '');
  const newDue = String(dueDate || '');
  if (newDue && newDue !== oldDue) {
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DueLog')
      .appendRow([taskId, oldDue, newDue, String(dueReason || ''), me.UserID, me.Name, new Date().toISOString()]);
  }

  let progress = parseInt(cur.Progress) || 0;
  let completedAt = cur.CompletedAt || '';
  if (status === 'เสร็จแล้ว') { progress = 100; if (!completedAt) completedAt = new Date().toISOString(); }
  else { if (progress >= 100) progress = 90; completedAt = ''; }

  setTaskFields_(taskId, {
    Project: project, Title: title, Description: description || '',
    AssigneeID: assigneeId, DueDate: newDue, Status: status || 'ยังไม่เริ่ม',
    Progress: progress, Priority: priority || 'ปกติ', CompletedAt: completedAt
  });

  const users = getSheetJson_('Users');
  const u = users.find(x => x.UserID === assigneeId);
  return {
    TaskID: taskId, Project: project, Title: title, Description: description || '',
    AssigneeID: assigneeId, AssigneeName: u ? u.Name : '', DueDate: newDue,
    Status: status || 'ยังไม่เริ่ม', Progress: progress, Priority: priority || 'ปกติ'
  };
}

// กดว่างานเสร็จ / เปิดงานใหม่ — ผู้ใช้ที่ลงทะเบียนแล้ว
function setTaskDone(actorEmail, taskId, done) {
  const me = resolveCurrentUser_(actorEmail);
  if (!me.UserID) throw new Error('บัญชีของคุณยังไม่ได้ลงทะเบียนในระบบ');
  const ts = new Date().toISOString();
  if (done) setTaskFields_(taskId, { Status: 'เสร็จแล้ว', Progress: 100, CompletedAt: ts });
  else setTaskFields_(taskId, { Status: 'กำลังทำ', Progress: 50, CompletedAt: '' });
  return { TaskID: taskId, Status: done ? 'เสร็จแล้ว' : 'กำลังทำ', Progress: done ? 100 : 50, CompletedAt: done ? ts : '' };
}

// เปลี่ยนสถานะงาน (รองรับ ส่งตรวจ/อนุมัติ) — สมาชิกแก้เฉพาะงานตัวเอง, เสร็จแล้ว/ยกเลิก ต้องเป็นหัวหน้า
function setStatus(actorEmail, taskId, status) {
  const me = resolveCurrentUser_(actorEmail);
  if (!me.UserID) throw new Error('บัญชีของคุณยังไม่ได้ลงทะเบียนในระบบ');
  const t = getTaskById_(taskId);
  if (!t) throw new Error('ไม่พบงานนี้');
  const allowed = ['ยังไม่เริ่ม', 'กำลังทำ', 'รอตรวจ', 'เสร็จแล้ว', 'ยกเลิก'];
  if (allowed.indexOf(status) === -1) throw new Error('สถานะไม่ถูกต้อง');
  if (!me.isBoss && t.AssigneeID !== me.UserID) throw new Error('แก้ได้เฉพาะงานของตัวเอง');
  if (!me.isBoss && (status === 'เสร็จแล้ว' || status === 'ยกเลิก')) throw new Error('การอนุมัติ/ยกเลิกงาน ต้องให้หัวหน้าทีมทำ');

  const fields = { Status: status };
  const ts = new Date().toISOString();
  if (status === 'เสร็จแล้ว') { fields.Progress = 100; if (!t.CompletedAt) fields.CompletedAt = ts; }
  else { fields.CompletedAt = ''; if (parseInt(t.Progress) >= 100) fields.Progress = 90; }

  setTaskFields_(taskId, fields);
  return { TaskID: taskId, Status: status, Progress: fields.hasOwnProperty('Progress') ? fields.Progress : (parseInt(t.Progress) || 0), CompletedAt: fields.CompletedAt || '' };
}

// ลบงาน — เฉพาะหัวหน้า (ลบคอมเมนต์ของงานด้วย)
function deleteTask(actorEmail, taskId) {
  requireBoss_(actorEmail);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Tasks');
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === taskId) { sheet.deleteRow(i + 1); break; }
  }
  const cSheet = ss.getSheetByName('Comments');
  if (cSheet) {
    const cData = cSheet.getDataRange().getValues();
    for (let i = cData.length - 1; i >= 1; i--) {
      if (cData[i][0] === taskId) cSheet.deleteRow(i + 1);
    }
  }
  return true;
}

// บันทึกคอมเมนต์ — ผู้ใช้ที่ลงทะเบียนแล้วเท่านั้น (ดึงตัวตนจากเซิร์ฟเวอร์ ไม่เชื่อค่าจากฝั่งหน้าเว็บ)
function saveComment(actorEmail, taskId, message) {
  const me = resolveCurrentUser_(actorEmail);
  if (!me.UserID) throw new Error('บัญชีของคุณยังไม่ได้ลงทะเบียนในระบบ');
  const ts = new Date().toISOString();
  SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Comments')
    .appendRow([taskId, me.UserID, message, ts]);
  return { UserID: me.UserID, Name: me.Name, Message: message, Timestamp: ts };
}

// อัปเดตโปรไฟล์ตัวเอง (รูป + สเตตัสใต้ชื่อ) — ผู้ใช้ที่ลงทะเบียนแล้ว
function updateProfile(actorEmail, photo, status) {
  const me = resolveCurrentUser_(actorEmail);
  if (!me.UserID) throw new Error('บัญชีของคุณยังไม่ได้ลงทะเบียนในระบบ');
  // จำกัดขนาดรูป (กันเกินความจุช่องของ Google Sheet ~50,000 อักขระ)
  const photoVal = String(photo || '');
  if (photoVal.length > 49000) throw new Error('ไฟล์รูปใหญ่เกินไป กรุณาใช้รูปที่เล็กลง');
  setUserFields_(me.UserID, { Photo: photoVal, Status: String(status || '') });
  return { UserID: me.UserID, Photo: photoVal, Status: String(status || '') };
}

// หัวหน้าแก้ไขข้อมูลสมาชิก (ชื่อ/ตำแหน่ง/อีเมล/ตั้งเป็นหัวหน้า/เปิด-ปิดใช้งาน)
function updateMember(actorEmail, userId, name, role, email, isBoss, active) {
  requireBoss_(actorEmail);
  const fields = {
    Name: name, Role: role || 'ทีมงาน',
    Email: String(email || '').toLowerCase(), IsBoss: isBoss ? 'TRUE' : '',
    Active: active ? 'TRUE' : 'FALSE'
  };
  setUserFields_(userId, fields);
  return { UserID: userId, Name: fields.Name, Role: fields.Role, Email: fields.Email, IsBoss: fields.IsBoss, Active: fields.Active };
}

// ลบสมาชิก — เฉพาะหัวหน้า (ลบได้เฉพาะเมื่อไม่มีงานค้างอยู่)
function deleteMember(actorEmail, userId) {
  requireBoss_(actorEmail);
  const tasks = getSheetJson_('Tasks');
  const owned = tasks.filter(t => t.AssigneeID === userId).length;
  if (owned > 0) throw new Error('ลบไม่ได้ เพราะยังมีงานอยู่ ' + owned + ' งาน — โปรดย้ายผู้รับผิดชอบหรือลบงานก่อน (หรือใช้ปิดการใช้งานแทน)');
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Users');
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === userId) { sheet.deleteRow(i + 1); break; }
  }
  return true;
}

// อัปเดตความคืบหน้า — ผู้ใช้ที่ลงทะเบียนแล้ว
function updateProgress(actorEmail, taskId, progress) {
  const me = resolveCurrentUser_(actorEmail);
  if (!me.UserID) throw new Error('บัญชีของคุณยังไม่ได้ลงทะเบียนในระบบ');
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Tasks');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === taskId) {
      sheet.getRange(i + 1, 8).setValue(progress);
      break;
    }
  }
  return true;
}
