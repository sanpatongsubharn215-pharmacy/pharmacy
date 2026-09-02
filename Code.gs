/**
 * The Watcher - ระบบแจ้งเตือนวันหมดอายุของยา
 * Backend: Google Apps Script (JSON API) + Google Sheets (JSON-per-row)
 * Part 1: doGet/doPost router + CORS-safe + initializeSheets + auth + config/logo upload
 *
 * วิธีติดตั้ง (ดู README.md):
 *  1) วาง Code.gs นี้ในโปรเจกต์ Apps Script ที่ผูกกับ Google Sheet เปล่า
 *  2) รันฟังก์ชัน setup() หนึ่งครั้ง (อนุญาตสิทธิ์ Drive/Sheets)
 *  3) Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone
 *  4) คัดลอก URL /exec ไปใส่ js/api.js (ค่า API_URL)
 */

// ============================================================ CONFIG
var CONFIG = {
  APP_NAME: 'The Watcher',
  APP_VERSION: '1.0',
  HOSPITAL_NAME: 'โรงพยาบาลร้องกวาง',
  SESSION_TIMEOUT: 8 * 60 * 60 * 1000, // 8 ชม.
  FOLDER_NAME: 'The Watcher - Files',

  // ผู้ใช้เริ่มต้น (เปลี่ยนรหัสผ่านหลังติดตั้ง)
  ADMIN_USERS: {
    admin: 'admin1234'
  },
  USER_ROLES: {
    admin:      { name: 'ผู้ดูแลระบบ', permissions: ['*'] },
    pharmacist: { name: 'เภสัชกร',     permissions: ['stock', 'drug', 'exchange', 'receive', 'view'] },
    staff:      { name: 'เจ้าหน้าที่',  permissions: ['receive', 'view'] }
  },

  EXPIRY: { critical: 35, high: 60, medium: 120 },

  SHEET_KEYS: {
    Config:       'config_json',
    Locations:    'location_json',
    Drugs:        'drug_json',
    Items:        'item_json',
    Transactions: 'transaction_json',
    Users:        'user_json',
    Sessions:     'session_json',
    Errors:       'error_json'
  }
};

// ============================================================ ENTRY / ROUTER
function doGet(e)  { return handle_(e, 'GET'); }
function doPost(e) { return handle_(e, 'POST'); }

function handle_(e, method) {
  try {
    var p = {};
    if (method === 'POST' && e && e.postData && e.postData.contents) {
      // POST แบบ text/plain เพื่อเลี่ยง CORS preflight
      p = JSON.parse(e.postData.contents);
    } else if (e && e.parameter) {
      p = e.parameter;
      if (p.payload) { try { p = JSON.parse(p.payload); } catch (_) {} }
    }
    var action = p.action;
    return jsonOut_(route_(action, p));
  } catch (err) {
    logError_('handle_', err);
    return jsonOut_({ status: 'error', message: 'เกิดข้อผิดพลาด: ' + err });
  }
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function route_(action, p) {
  switch (action) {
    // public
    case 'ping':         return { status: 'success', message: 'pong', time: now_() };
    case 'branding':     return apiBranding_();
    case 'login':        return apiLogin_(p.username, p.password);

    // auth required
    case 'logout':       return apiLogout_(p.token);
    case 'me':           return guard_(p, ['view'], function (u) { return { status: 'success', user: publicUser_(u) }; });

    case 'getConfig':    return guard_(p, ['*'],    function ()  { return apiGetConfig_(); });
    case 'saveConfig':   return guard_(p, ['*'],    function ()  { return apiSaveConfig_(p.config); });
    case 'uploadLogo':   return guard_(p, ['*'],    function ()  { return apiUploadLogo_(p.base64, p.filename); });
    case 'removeLogo':   return guard_(p, ['*'],    function ()  { return apiRemoveLogo_(); });

    case 'getLocations': return guard_(p, ['view'], function ()  { return { status: 'success', data: readAll_('Locations').filter(activeOnly_) }; });

    // ---- Part 2: locations admin ----
    case 'saveLocation':      return guard_(p, ['drug'], function () { return apiSaveLocation_(p.location); });
    case 'deleteLocation':    return guard_(p, ['drug'], function () { return apiDeleteLocation_(p.id); });
    case 'reorderLocations':  return guard_(p, ['drug'], function () { return apiReorderLocations_(p.ids); });
    case 'setDefaultReceive': return guard_(p, ['drug'], function () { return apiSetDefaultReceive_(p.id); });

    // ---- Part 2: drugs ----
    case 'getDrugs':       return guard_(p, ['view'], function () { return apiGetDrugs_(); });
    case 'saveDrug':       return guard_(p, ['drug'], function () { return apiSaveDrug_(p.drug); });
    case 'deleteDrug':     return guard_(p, ['drug'], function () { return apiDeleteDrug_(p.id); });
    case 'setRequireLot':  return guard_(p, ['drug'], function () { return apiSetRequireLot_(p.id, p.value); });
    case 'uploadImage':    return guard_(p, ['drug'], function () { return apiUploadImage_(p.base64, p.filename); });

    // ---- Part 3: receive / items ----
    case 'receiveItem':    return guard_(p, ['receive'], function (u) { return apiReceiveItem_(p, u); });
    case 'recentReceives': return guard_(p, ['view'],    function ()  { return apiRecentReceives_(p.limit || 20); });
    case 'findDrugByCode': return guard_(p, ['view'],    function ()  { return apiFindDrugByCode_(p.code); });

    // ---- Part 4: dashboard ----
    case 'getDashboard':   return guard_(p, ['view'], function () { return apiGetDashboard_(); });
    case 'searchItems':    return guard_(p, ['view'], function () { return apiSearchItems_(p.q); });

    // ---- Part 5: location stock + exchange ----
    case 'getLocationStock': return guard_(p, ['view'],     function ()  { return apiGetLocationStock_(); });
    case 'getLocationItems': return guard_(p, ['view'],     function ()  { return apiGetLocationItems_(p.location_id); });
    case 'exchangeItem':     return guard_(p, ['exchange'], function (u) { return apiExchangeItem_(p, u); });
    case 'recentExchanges':  return guard_(p, ['view'],     function ()  { return apiRecentExchanges_(p.limit || 20); });

    // ---- ใบเบิก / issue (stock-out, FIFO) ----
    case 'issueSearch':      return guard_(p, ['view'],    function ()  { return apiIssueSearch_(p.q); });
    case 'issueItem':        return guard_(p, ['receive'], function (u) { return apiIssueItem_(p, u); });
    case 'issueSlip':        return guard_(p, ['receive'], function (u) { return apiIssueSlip_(p, u); });
    case 'getIssueSlip':     return guard_(p, ['view'],    function ()  { return apiGetIssueSlip_(p.slip_no); });
    case 'recentIssues':     return guard_(p, ['view'],    function ()  { return apiRecentIssues_(p.limit || 20); });

    // ---- Part 6: notifications + account ----
    case 'getNotifyConfig':  return guard_(p, ['*'],    function ()  { return apiGetNotifyConfig_(); });
    case 'saveNotifyConfig': return guard_(p, ['*'],    function ()  { return apiSaveNotifyConfig_(p.notification); });
    case 'testNotification': return guard_(p, ['*'],    function ()  { return apiTestNotification_(); });
    case 'changePassword':   return guard_(p, ['view'], function (u) { return apiChangePassword_(p, u); });

    // ---- Part 6: export ----
    case 'exportData':       return guard_(p, ['view'], function ()  { return apiExportData_(p); });

    // ---- Extra: dispose / history / users ----
    case 'disposeItem':      return guard_(p, ['receive'], function (u) { return apiDisposeItem_(p, u); });
    case 'getHistory':       return guard_(p, ['view'],    function ()  { return apiGetHistory_(p); });
    case 'getUsers':         return guard_(p, ['*'],       function ()  { return apiGetUsers_(); });
    case 'saveUser':         return guard_(p, ['*'],       function (u) { return apiSaveUser_(p.user, u); });
    case 'deleteUser':       return guard_(p, ['*'],       function (u) { return apiDeleteUser_(p.id, u); });

    // ---- Extra2: low stock / audit ----
    case 'getLowStock':      return guard_(p, ['view'],  function ()  { return apiGetLowStock_(); });
    case 'adjustItem':       return guard_(p, ['stock'], function (u) { return apiAdjustItem_(p, u); });

    default:             return { status: 'error', message: 'ไม่รู้จักคำสั่ง: ' + action };
  }
}

// ============================================================ AUTH
function apiLogin_(username, password) {
  ensureInit_();
  if (!username || !password) return { status: 'error', message: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' };

  var users = readAll_('Users');
  var u = null;
  for (var i = 0; i < users.length; i++) {
    if (users[i].username === username) { u = users[i]; break; }
  }
  if (!u || !u.active) return { status: 'error', message: 'ไม่พบบัญชีผู้ใช้นี้' };
  if (String(u.password) !== String(password)) return { status: 'error', message: 'รหัสผ่านไม่ถูกต้อง' };

  var token = Utilities.getUuid();
  appendRecord_('Sessions', {
    id: token,
    username: u.username,
    role: u.role,
    created_at: now_(),
    expires_at: new Date(Date.now() + CONFIG.SESSION_TIMEOUT).toISOString()
  });

  u.last_login = now_();
  updateRecord_('Users', u.id, u);

  return { status: 'success', token: token, user: publicUser_(u) };
}

function apiLogout_(token) {
  if (token) {
    var sh = getSheet_('Sessions');
    var rows = readAll_('Sessions');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id === token) { sh.deleteRow(rows[i]._row); break; }
    }
  }
  return { status: 'success', message: 'ออกจากระบบแล้ว' };
}

function getSession_(token) {
  if (!token) return null;
  var rows = readAll_('Sessions');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id === token) {
      if (new Date(rows[i].expires_at).getTime() < Date.now()) return null;
      return rows[i];
    }
  }
  return null;
}

function findUserByUsername_(username) {
  var users = readAll_('Users');
  for (var i = 0; i < users.length; i++) if (users[i].username === username) return users[i];
  return null;
}

function hasPerm_(user, perms) {
  if (!user.permissions) return false;
  if (user.permissions.indexOf('*') !== -1) return true;
  for (var i = 0; i < perms.length; i++) {
    if (perms[i] === '*') continue;
    if (user.permissions.indexOf(perms[i]) !== -1) return true;
  }
  return false;
}

/** หุ้มทุก action ที่ต้องล็อกอิน: ตรวจ session + สิทธิ์ */
function guard_(p, perms, fn) {
  var s = getSession_(p.token);
  if (!s) return { status: 'error', code: 'AUTH', message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' };
  var user = findUserByUsername_(s.username);
  if (!user || !user.active) return { status: 'error', code: 'AUTH', message: 'บัญชีถูกปิดใช้งาน' };
  if (perms && perms.length && !hasPerm_(user, perms)) return { status: 'error', message: 'ไม่มีสิทธิ์ใช้งานส่วนนี้' };
  return fn(user);
}

function publicUser_(u) {
  return { username: u.username, name: u.name, role: u.role, permissions: u.permissions };
}

// ============================================================ CONFIG / BRANDING / LOGO
function apiBranding_() {
  ensureInit_();
  var c = readConfig_();
  return {
    status: 'success',
    branding: {
      hospital_name: c.hospital_name || CONFIG.HOSPITAL_NAME,
      logo_url: c.logo_file_id ? logoUrl_(c.logo_file_id) : '',
      app_name: CONFIG.APP_NAME,
      app_version: c.app_version || CONFIG.APP_VERSION,
      thresholds: c.expiry_thresholds || { critical: CONFIG.EXPIRY.critical, high: CONFIG.EXPIRY.high, medium: CONFIG.EXPIRY.medium },
      display_be: !!c.display_be
    }
  };
}

function apiGetConfig_() {
  var c = readConfig_();
  c.logo_url = c.logo_file_id ? logoUrl_(c.logo_file_id) : '';
  // ไม่ส่ง secret กลับ frontend
  if (c.notification) {
    c.notification = {
      enabled: !!c.notification.enabled,
      channel: c.notification.channel || 'telegram',
      notify_time: c.notification.notify_time || '08:00',
      has_telegram: !!c.notification.telegram_bot_token,
      has_line: !!c.notification.line_token
    };
  }
  return { status: 'success', config: c };
}

function apiSaveConfig_(patch) {
  var c = readConfig_();
  if (patch && typeof patch === 'object') {
    if (patch.hospital_name !== undefined) c.hospital_name = String(patch.hospital_name).trim();
    if (patch.expiry_thresholds) c.expiry_thresholds = patch.expiry_thresholds;
    if (patch.default_receive_location_id !== undefined) c.default_receive_location_id = patch.default_receive_location_id;
    if (patch.display_be !== undefined) c.display_be = !!patch.display_be;
    if (patch.issue_form && typeof patch.issue_form === 'object') {
      var cur = c.issue_form || defaultIssueForm_();
      Object.keys(patch.issue_form).forEach(function (k) { if (k !== 'seq') cur[k] = String(patch.issue_form[k] || '').trim(); });
      c.issue_form = cur;
    }
    // notification secret ปรับแยกใน part ถัดไป
  }
  c.updated_at = now_();
  writeConfig_(c);
  return { status: 'success', message: 'บันทึกการตั้งค่าแล้ว', config: { hospital_name: c.hospital_name } };
}

function apiUploadLogo_(base64, filename) {
  if (!base64) return { status: 'error', message: 'ไม่พบไฟล์รูป' };
  var c = readConfig_();
  var folder = getFolder_(c);
  var dataPart = base64.indexOf(',') !== -1 ? base64.split(',').pop() : base64;
  var bytes = Utilities.base64Decode(dataPart);
  var blob = Utilities.newBlob(bytes, guessMime_(filename), filename || ('logo_' + Date.now() + '.png'));

  if (c.logo_file_id) { try { DriveApp.getFileById(c.logo_file_id).setTrashed(true); } catch (_) {} }

  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  c.logo_file_id = file.getId();
  c.updated_at = now_();
  writeConfig_(c);

  return { status: 'success', message: 'อัปโหลดโลโก้แล้ว', logo_url: logoUrl_(c.logo_file_id) };
}

function apiRemoveLogo_() {
  var c = readConfig_();
  if (c.logo_file_id) { try { DriveApp.getFileById(c.logo_file_id).setTrashed(true); } catch (_) {} }
  c.logo_file_id = '';
  c.updated_at = now_();
  writeConfig_(c);
  return { status: 'success', message: 'ลบโลโก้แล้ว' };
}

function logoUrl_(fileId) {
  // ใช้ thumbnail endpoint hotlink ได้ดีกับ origin ภายนอก (GitHub Pages)
  return 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w512';
}

function getFolder_(c) {
  if (c.folder_id) {
    try { return DriveApp.getFolderById(c.folder_id); } catch (_) {}
  }
  var folder = DriveApp.createFolder(CONFIG.FOLDER_NAME);
  c.folder_id = folder.getId();
  writeConfig_(c);
  return folder;
}

function guessMime_(name) {
  name = (name || '').toLowerCase();
  if (name.match(/\.png$/)) return 'image/png';
  if (name.match(/\.(jpg|jpeg)$/)) return 'image/jpeg';
  if (name.match(/\.webp$/)) return 'image/webp';
  if (name.match(/\.svg$/)) return 'image/svg+xml';
  return 'image/png';
}

function readConfig_() {
  var sh = getSheet_('Config');
  if (sh.getLastRow() < 2) { ensureInit_(); }
  var v = sh.getRange(2, 1).getValue();
  try { return JSON.parse(v); } catch (_) { return defaultConfig_(); }
}

function writeConfig_(c) {
  getSheet_('Config').getRange(2, 1).setValue(JSON.stringify(c));
}

function defaultConfig_() {
  return {
    hospital_name: CONFIG.HOSPITAL_NAME,
    logo_file_id: '',
    folder_id: '',
    expiry_thresholds: { critical: CONFIG.EXPIRY.critical, high: CONFIG.EXPIRY.high, medium: CONFIG.EXPIRY.medium },
    default_receive_location_id: '',
    notification: { enabled: false, channel: 'telegram', telegram_bot_token: '', telegram_chat_id: '', line_token: '', notify_time: '08:00' },
    issue_form: defaultIssueForm_(),
    app_version: CONFIG.APP_VERSION,
    created_at: now_(),
    updated_at: now_()
  };
}

// ค่าเริ่มต้นหัว/ท้ายใบเบิก (แก้ได้ที่ ตั้งค่า > ใบเบิก)
function defaultIssueForm_() {
  return {
    title: 'ใบเบิกเวชภัณฑ์ยาและเวชภัณฑ์มิใช่ยา',
    org_unit: 'งานคลังเวชภัณฑ์',
    from_unit: '',
    to_label: 'หัวหน้าหน่วยพัสดุ',
    issuer_name: '',
    issuer_position: '',
    approver_name: '',
    approver_position: '',
    seq: 0
  };
}

// ============================================================ INIT / SEED
function setup() {
  var r = initializeSheets();
  Logger.log(r.message);
  Logger.log('ติดตั้งเสร็จ ทำขั้นตอน Deploy ต่อได้เลย');
  return r;
}

function ensureInit_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName('Config') || !ss.getSheetByName('Users')) {
    initializeSheets();
  }
}

function initializeSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var names = ss.getSheets().map(function (s) { return s.getName(); });

  Object.keys(CONFIG.SHEET_KEYS).forEach(function (sheetName) {
    if (names.indexOf(sheetName) === -1) {
      var sh = ss.insertSheet(sheetName);
      sh.appendRow([CONFIG.SHEET_KEYS[sheetName]]);
    }
  });

  // Config (แถวเดียว)
  var cfgSheet = ss.getSheetByName('Config');
  if (cfgSheet.getLastRow() < 2) {
    cfgSheet.appendRow([JSON.stringify(defaultConfig_())]);
  }

  // Locations seed
  var locSheet = ss.getSheetByName('Locations');
  if (locSheet.getLastRow() < 2) seedLocations_(locSheet);

  // Users seed / migrate
  var userSheet = ss.getSheetByName('Users');
  if (userSheet.getLastRow() < 2) {
    seedUsers_(userSheet);
  } else {
    try { migrateOldUsers(); } catch (e) { logError_('migrateOldUsers', e); }
  }

  return { status: 'success', message: 'สร้าง sheets ทั้งหมดเรียบร้อยแล้ว' };
}

function seedLocations_(sheet) {
  // [ชื่อ, ไอคอน(key), สี]
  var data = [
    ['Substock',        'box',      '#16A34A'],
    ['Active Stock',    'bolt',     '#16A34A'],
    ['Main Stock',      'archive',  '#16A34A'],
    ['PCU Stock',       'building', '#2563EB'],
    ['รถยาเวรดึก IPD',  'cart',     '#F97316'],
    ['รถยาเวรดึก ER',   'cart',     '#F97316'],
    ['Ward Stock',      'bed',      '#2563EB'],
    ['ER Stock',        'asterisk', '#06B6D4'],
    ['LR Stock',        'people',   '#2563EB']
  ];
  data.forEach(function (row, idx) {
    sheet.appendRow([JSON.stringify({
      id: Utilities.getUuid(),
      name: row[0],
      icon: row[1],
      color: row[2],
      is_default_receive: idx === 0,
      sort_order: idx + 1,
      active: true,
      created_at: now_(),
      updated_at: now_()
    })]);
  });
}

function seedUsers_(sheet) {
  Object.keys(CONFIG.ADMIN_USERS).forEach(function (username) {
    var roleKey = CONFIG.USER_ROLES[username] ? username : 'admin';
    sheet.appendRow([JSON.stringify({
      id: Utilities.getUuid(),
      username: username,
      password: CONFIG.ADMIN_USERS[username],
      role: roleKey,
      name: CONFIG.USER_ROLES[roleKey].name,
      permissions: CONFIG.USER_ROLES[roleKey].permissions,
      active: true,
      last_login: '',
      created_at: now_(),
      updated_at: now_()
    })]);
  });
}

function migrateOldUsers() {
  // เผื่อมี Users sheet เดิม: เติม field ที่ขาด
  var users = readAll_('Users');
  var changed = 0;
  users.forEach(function (u) {
    var patched = false;
    if (!u.permissions) {
      var rk = CONFIG.USER_ROLES[u.role] ? u.role : 'staff';
      u.permissions = CONFIG.USER_ROLES[rk].permissions;
      patched = true;
    }
    if (u.active === undefined) { u.active = true; patched = true; }
    if (patched) { updateRecord_('Users', u.id, u); changed++; }
  });
  return { status: 'success', message: 'migrate ผู้ใช้แล้ว ' + changed + ' รายการ' };
}

// ============================================================ SHEET HELPERS (JSON-per-row)
function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow([CONFIG.SHEET_KEYS[name] || (name.toLowerCase() + '_json')]);
  }
  return sh;
}

function readAll_(name) {
  var sh = getSheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, 1).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var cell = vals[i][0];
    if (!cell) continue;
    try {
      var o = JSON.parse(cell);
      o._row = i + 2;
      out.push(o);
    } catch (e) { /* ข้ามแถวเสีย */ }
  }
  return out;
}

function appendRecord_(name, obj) {
  getSheet_(name).appendRow([JSON.stringify(stripMeta_(obj))]);
  return obj;
}

function updateRecord_(name, id, obj) {
  var sh = getSheet_(name);
  var rows = readAll_(name);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id === id) {
      sh.getRange(rows[i]._row, 1).setValue(JSON.stringify(stripMeta_(obj)));
      return obj;
    }
  }
  return null;
}

function findById_(name, id) {
  var rows = readAll_(name);
  for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
  return null;
}

function stripMeta_(obj) {
  var clean = {};
  Object.keys(obj).forEach(function (k) { if (k !== '_row') clean[k] = obj[k]; });
  return clean;
}

function activeOnly_(x) { return x.active !== false; }

// ============================================================ LOCATIONS (Part 2)
function apiSaveLocation_(loc) {
  if (!loc || !loc.name || !String(loc.name).trim()) return { status: 'error', message: 'กรุณากรอกชื่อสถานที่' };
  var name = String(loc.name).trim();

  if (loc.id) {
    var ex = findById_('Locations', loc.id);
    if (!ex) return { status: 'error', message: 'ไม่พบสถานที่' };
    ex.name = name;
    if (loc.icon !== undefined) ex.icon = loc.icon;
    if (loc.color !== undefined) ex.color = loc.color;
    ex.updated_at = now_();
    updateRecord_('Locations', ex.id, ex);
    return { status: 'success', message: 'บันทึกแล้ว', location: stripMeta_(ex) };
  }

  var all = readAll_('Locations');
  var maxOrder = 0;
  all.forEach(function (x) { if ((x.sort_order || 0) > maxOrder) maxOrder = x.sort_order; });
  var rec = {
    id: Utilities.getUuid(),
    name: name,
    icon: loc.icon || 'box',
    color: loc.color || '#16A34A',
    is_default_receive: false,
    sort_order: maxOrder + 1,
    active: true,
    created_at: now_(),
    updated_at: now_()
  };
  appendRecord_('Locations', rec);
  return { status: 'success', message: 'เพิ่มสถานที่แล้ว', location: rec };
}

function apiDeleteLocation_(id) {
  var ex = findById_('Locations', id);
  if (!ex) return { status: 'error', message: 'ไม่พบสถานที่' };
  ex.active = false;
  ex.updated_at = now_();
  updateRecord_('Locations', id, ex);
  if (ex.is_default_receive) {
    var c = readConfig_();
    if (c.default_receive_location_id === id) { c.default_receive_location_id = ''; writeConfig_(c); }
  }
  return { status: 'success', message: 'ลบสถานที่แล้ว' };
}

function apiReorderLocations_(ids) {
  if (!ids || !ids.length) return { status: 'error', message: 'ไม่มีข้อมูลลำดับ' };
  ids.forEach(function (id, idx) {
    var ex = findById_('Locations', id);
    if (ex) { ex.sort_order = idx + 1; ex.updated_at = now_(); updateRecord_('Locations', id, ex); }
  });
  return { status: 'success', message: 'จัดลำดับแล้ว' };
}

function apiSetDefaultReceive_(id) {
  var all = readAll_('Locations');
  all.forEach(function (x) {
    var should = (x.id === id);
    if (!!x.is_default_receive !== should) {
      x.is_default_receive = should; x.updated_at = now_();
      updateRecord_('Locations', x.id, x);
    }
  });
  var c = readConfig_();
  c.default_receive_location_id = id;
  c.updated_at = now_();
  writeConfig_(c);
  return { status: 'success', message: 'ตั้งจุดเริ่มต้นรับเข้าแล้ว' };
}

// ============================================================ DRUGS (Part 2)
function imageUrl_(fileId) { return 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w320'; }

function buildDrugImageMap_() {
  var m = {};
  readAll_('Drugs').forEach(function (d) { if (d.image_file_id) m[d.id] = imageUrl_(d.image_file_id); });
  return m;
}

function apiGetDrugs_() {
  var drugs = readAll_('Drugs').filter(activeOnly_).map(function (d) {
    var o = stripMeta_(d);
    o.image_url = d.image_file_id ? imageUrl_(d.image_file_id) : '';
    return o;
  });
  return { status: 'success', data: drugs };
}

function apiUploadImage_(base64, filename) {
  if (!base64) return { status: 'error', message: 'ไม่พบไฟล์รูป' };
  var c = readConfig_();
  var folder = getFolder_(c);
  var dataPart = base64.indexOf(',') !== -1 ? base64.split(',').pop() : base64;
  var blob = Utilities.newBlob(Utilities.base64Decode(dataPart), guessMime_(filename), filename || ('drug_' + Date.now() + '.jpg'));
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { status: 'success', file_id: file.getId(), url: imageUrl_(file.getId()) };
}

function apiSaveDrug_(d) {
  if (!d || !d.name || !String(d.name).trim()) return { status: 'error', message: 'กรุณากรอกชื่อยา' };
  d.name = String(d.name).trim();

  var code = String(d.code || '').trim();
  if (code) {
    var existing = readAll_('Drugs').filter(activeOnly_);
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].code && existing[i].code === code && existing[i].id !== d.id) {
        return { status: 'error', message: 'บาร์โค้ดนี้มีอยู่แล้ว: ' + existing[i].name };
      }
    }
  }

  if (d.id) {
    var ex = findById_('Drugs', d.id);
    if (!ex) return { status: 'error', message: 'ไม่พบรายการยา' };
    ex.name = d.name;
    ex.code = code;
    ex.unit = String(d.unit || '').trim();
    ex.require_lot = !!d.require_lot;
    ex.default_location_id = (d.default_location_id !== undefined) ? d.default_location_id : ex.default_location_id;
    if (d.image_file_id !== undefined && d.image_file_id) {
      if (ex.image_file_id && ex.image_file_id !== d.image_file_id) { try { DriveApp.getFileById(ex.image_file_id).setTrashed(true); } catch (_) {} }
      ex.image_file_id = d.image_file_id;
    }
    if (d.clear_image) { if (ex.image_file_id) { try { DriveApp.getFileById(ex.image_file_id).setTrashed(true); } catch (_) {} } ex.image_file_id = ''; }
    ex.min_qty = (d.min_qty !== undefined) ? (Number(d.min_qty) || 0) : (ex.min_qty || 0);
    ex.price = Number(d.price) || 0;
    ex.category = String(d.category || '');
    ex.updated_at = now_();
    updateRecord_('Drugs', d.id, ex);
    var outU = stripMeta_(ex); outU.image_url = ex.image_file_id ? imageUrl_(ex.image_file_id) : '';
    return { status: 'success', message: 'บันทึกแล้ว', drug: outU };
  }

  var rec = {
    id: Utilities.getUuid(),
    name: d.name,
    code: code,
    unit: String(d.unit || '').trim(),
    require_lot: !!d.require_lot,
    default_location_id: d.default_location_id || '',
    image_file_id: d.image_file_id || '',
    min_qty: Number(d.min_qty) || 0,
    price: Number(d.price) || 0,
    category: String(d.category || ''),
    active: true,
    created_at: now_(),
    updated_at: now_()
  };
  appendRecord_('Drugs', rec);
  var outN = stripMeta_(rec); outN.image_url = rec.image_file_id ? imageUrl_(rec.image_file_id) : '';
  return { status: 'success', message: 'เพิ่มยาแล้ว', drug: outN };
}

function apiDeleteDrug_(id) {
  var ex = findById_('Drugs', id);
  if (!ex) return { status: 'error', message: 'ไม่พบรายการยา' };
  ex.active = false;
  ex.updated_at = now_();
  updateRecord_('Drugs', id, ex);
  return { status: 'success', message: 'ลบรายการยาแล้ว' };
}

function apiSetRequireLot_(id, value) {
  var ex = findById_('Drugs', id);
  if (!ex) return { status: 'error', message: 'ไม่พบรายการยา' };
  ex.require_lot = !!value;
  ex.updated_at = now_();
  updateRecord_('Drugs', id, ex);
  return { status: 'success', message: 'อัปเดตแล้ว' };
}

// ============================================================ RECEIVE / ITEMS (Part 3)
function apiReceiveItem_(p, user) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);

    var drug = findById_('Drugs', p.drug_id);
    if (!drug || drug.active === false) return { status: 'error', message: 'ไม่พบรายการยา' };

    var loc = findById_('Locations', p.location_id);
    if (!loc || loc.active === false) return { status: 'error', message: 'ไม่พบสถานที่เก็บ' };

    var qty = Number(p.qty);
    if (!qty || qty <= 0) return { status: 'error', message: 'จำนวนต้องมากกว่า 0' };

    var expiry = String(p.expiry_date || '').trim();
    if (!expiry) return { status: 'error', message: 'กรุณาระบุวันหมดอายุ' };

    var lot = String(p.lot_no || '').trim();
    if (drug.require_lot && !lot) return { status: 'error', message: 'ยานี้ต้องระบุ Lot No.' };

    // รวมเข้ารายการเดิมถ้า ยา/จุด/Lot/วันหมดอายุ ตรงกัน
    var items = readAll_('Items');
    var item = null, merged = false;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.status === 'active' && it.drug_id === drug.id && it.location_id === loc.id &&
          (it.lot_no || '') === lot && it.expiry_date === expiry) {
        it.qty = Number(it.qty || 0) + qty;
        it.updated_at = now_();
        updateRecord_('Items', it.id, it);
        item = it; merged = true; break;
      }
    }
    if (!merged) {
      item = {
        id: Utilities.getUuid(),
        drug_id: drug.id, drug_name: drug.name,
        location_id: loc.id, location_name: loc.name,
        lot_no: lot, expiry_date: expiry, qty: qty,
        status: 'active',
        received_by: user.username, received_at: now_(),
        note: String(p.note || '').trim(),
        created_at: now_(), updated_at: now_()
      };
      appendRecord_('Items', item);
    }

    appendRecord_('Transactions', {
      id: Utilities.getUuid(), type: 'receive', item_id: item.id,
      drug_id: drug.id, drug_name: drug.name,
      from_location_id: '', from_location_name: '',
      to_location_id: loc.id, to_location_name: loc.name,
      qty: qty, lot_no: lot, expiry_date: expiry,
      by: user.username, created_at: now_()
    });

    return { status: 'success', message: merged ? 'รับเข้าแล้ว (รวมกับ Lot เดิม)' : 'รับเข้าแล้ว', item: stripMeta_(item), merged: merged };
  } catch (e) {
    logError_('receiveItem', e);
    return { status: 'error', message: 'บันทึกไม่สำเร็จ ลองอีกครั้ง' };
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function apiRecentReceives_(limit) {
  var tx = readAll_('Transactions').filter(function (t) { return t.type === 'receive'; });
  tx.sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
  var imgMap = buildDrugImageMap_();
  return { status: 'success', data: tx.slice(0, limit).map(function (t) { var o = stripMeta_(t); o.image_url = imgMap[t.drug_id] || ''; return o; }) };
}

function apiFindDrugByCode_(code) {
  code = String(code || '').trim();
  if (!code) return { status: 'success', drug: null };
  var found = readAll_('Drugs').filter(activeOnly_).filter(function (x) { return x.code === code; })[0];
  if (!found) return { status: 'success', drug: null };
  var o = stripMeta_(found); o.image_url = found.image_file_id ? imageUrl_(found.image_file_id) : '';
  return { status: 'success', drug: o };
}

// ============================================================ DASHBOARD (Part 4)
function daysTo_(dateStr) {
  if (!dateStr) return null;
  var tz = Session.getScriptTimeZone();
  var todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var t = new Date(todayStr + 'T00:00:00Z').getTime();
  var e = new Date(String(dateStr) + 'T00:00:00Z').getTime();
  if (isNaN(e)) return null;
  return Math.round((e - t) / 86400000);
}

function apiGetDashboard_() {
  var cfg = readConfig_();
  var th = cfg.expiry_thresholds || { critical: CONFIG.EXPIRY.critical, high: CONFIG.EXPIRY.high, medium: CONFIG.EXPIRY.medium };
  var items = readAll_('Items').filter(function (it) { return it.status === 'active'; });
  var s = { within35: 0, within60: 0, within120: 0, over120: 0, expired: 0, total_items: 0, total_qty: 0 };
  var near = [];
  var byLocMap = {};
  var imgMap = buildDrugImageMap_();

  items.forEach(function (it) {
    var qty = Number(it.qty || 0);
    if (qty <= 0) return;
    s.total_items++; s.total_qty += qty;

    var days = daysTo_(it.expiry_date);
    if (days == null) return;

    if (days < 0) s.expired++;
    if (days <= th.critical) s.within35++;
    else if (days <= th.high) s.within60++;
    else if (days <= th.medium) s.within120++;
    else s.over120++;

    if (days <= th.medium) {
      near.push({
        id: it.id, drug_id: it.drug_id, drug_name: it.drug_name, image_url: imgMap[it.drug_id] || '',
        location_id: it.location_id, location_name: it.location_name, lot_no: it.lot_no,
        expiry_date: it.expiry_date, qty: qty, days: days
      });
      var k = it.location_id || '_';
      if (!byLocMap[k]) byLocMap[k] = { location_id: it.location_id, location_name: it.location_name, count: 0, qty: 0 };
      byLocMap[k].count++; byLocMap[k].qty += qty;
    }
  });

  near.sort(function (a, b) { return a.days - b.days; });
  var byLoc = Object.keys(byLocMap).map(function (k) { return byLocMap[k]; })
    .sort(function (a, b) { return b.count - a.count; });

  var priceMap = {};
  readAll_('Drugs').forEach(function (d) { if (d.id) priceMap[d.id] = Number(d.price || 0); });
  var totalValue = 0;
  items.forEach(function (it) { var q = Number(it.qty || 0); if (q > 0) totalValue += q * (priceMap[it.drug_id] || 0); });

  return { status: 'success', summary: s, near: near.slice(0, 100), by_location: byLoc, thresholds: th, low_stock: apiGetLowStock_().data, total_value: Math.round(totalValue * 100) / 100 };
}

function apiSearchItems_(query) {
  var q = String(query || '').trim().toLowerCase();
  if (!q) return { status: 'success', data: [] };
  var items = readAll_('Items').filter(function (it) { return it.status === 'active' && Number(it.qty || 0) > 0; });
  var drugs = readAll_('Drugs');
  var codeMap = {};
  drugs.forEach(function (d) { if (d.id) codeMap[d.id] = (d.code || ''); });
  var out = [];
  var imgMap = buildDrugImageMap_();
  items.forEach(function (it) {
    var hay = ((it.drug_name || '') + ' ' + (it.location_name || '') + ' ' + (it.lot_no || '') + ' ' + (codeMap[it.drug_id] || '')).toLowerCase();
    if (hay.indexOf(q) !== -1) {
      out.push({
        id: it.id, drug_id: it.drug_id, drug_name: it.drug_name, image_url: imgMap[it.drug_id] || '',
        location_id: it.location_id, location_name: it.location_name,
        lot_no: it.lot_no, expiry_date: it.expiry_date, qty: Number(it.qty || 0), days: daysTo_(it.expiry_date)
      });
    }
  });
  out.sort(function (a, b) { return (a.days == null ? 1e9 : a.days) - (b.days == null ? 1e9 : b.days); });
  return { status: 'success', data: out.slice(0, 100) };
}

// ============================================================ LOCATION STOCK + EXCHANGE (Part 5)
function apiGetLocationStock_() {
  var locs = readAll_('Locations').filter(activeOnly_).sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
  var items = readAll_('Items').filter(function (it) { return it.status === 'active' && Number(it.qty || 0) > 0; });

  var map = {};
  var allCount = 0, allQty = 0;
  items.forEach(function (it) {
    var q = Number(it.qty || 0);
    allCount++; allQty += q;
    var k = it.location_id || '_';
    if (!map[k]) map[k] = { count: 0, qty: 0 };
    map[k].count++; map[k].qty += q;
  });

  var out = locs.map(function (l) {
    var m = map[l.id] || { count: 0, qty: 0 };
    return { id: l.id, name: l.name, icon: l.icon, color: l.color, count: m.count, qty: m.qty };
  });

  return { status: 'success', all: { count: allCount, qty: allQty }, locations: out };
}

function apiGetLocationItems_(locationId) {
  var items = readAll_('Items').filter(function (it) { return it.status === 'active' && Number(it.qty || 0) > 0; });
  if (locationId && locationId !== 'all') {
    items = items.filter(function (it) { return it.location_id === locationId; });
  }
  var imgMap = buildDrugImageMap_();
  var out = items.map(function (it) {
    return {
      id: it.id, drug_id: it.drug_id, drug_name: it.drug_name, image_url: imgMap[it.drug_id] || '',
      location_id: it.location_id, location_name: it.location_name,
      lot_no: it.lot_no, expiry_date: it.expiry_date, qty: Number(it.qty || 0), days: daysTo_(it.expiry_date)
    };
  });
  out.sort(function (a, b) { return (a.days == null ? 1e9 : a.days) - (b.days == null ? 1e9 : b.days); });
  return { status: 'success', data: out };
}

function apiExchangeItem_(p, user) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);

    var item = findById_('Items', p.item_id);
    if (!item || item.status !== 'active') return { status: 'error', message: 'ไม่พบรายการยา หรือถูกย้ายไปแล้ว' };

    var qty = Number(p.qty);
    if (!qty || qty <= 0) return { status: 'error', message: 'จำนวนต้องมากกว่า 0' };
    if (qty > Number(item.qty || 0)) return { status: 'error', message: 'จำนวนเกินกว่าที่มี (' + item.qty + ')' };

    var dest = findById_('Locations', p.to_location_id);
    if (!dest || dest.active === false) return { status: 'error', message: 'ไม่พบสถานที่ปลายทาง' };
    if (dest.id === item.location_id) return { status: 'error', message: 'ปลายทางต้องไม่ใช่สถานที่เดิม' };

    var srcLocId = item.location_id, srcLocName = item.location_name;
    var lot = item.lot_no || '', expiry = item.expiry_date, drugId = item.drug_id, drugName = item.drug_name;

    // ลดจากต้นทาง
    item.qty = Number(item.qty || 0) - qty;
    if (item.qty <= 0) { item.qty = 0; item.status = 'exchanged'; }
    item.updated_at = now_();
    updateRecord_('Items', item.id, item);

    // เพิ่ม/รวมที่ปลายทาง
    var dItems = readAll_('Items');
    var destItem = null;
    for (var i = 0; i < dItems.length; i++) {
      var x = dItems[i];
      if (x.status === 'active' && x.drug_id === drugId && x.location_id === dest.id &&
          (x.lot_no || '') === lot && x.expiry_date === expiry) {
        x.qty = Number(x.qty || 0) + qty; x.updated_at = now_();
        updateRecord_('Items', x.id, x); destItem = x; break;
      }
    }
    if (!destItem) {
      destItem = {
        id: Utilities.getUuid(), drug_id: drugId, drug_name: drugName,
        location_id: dest.id, location_name: dest.name,
        lot_no: lot, expiry_date: expiry, qty: qty, status: 'active',
        received_by: user.username, received_at: now_(),
        note: 'รับโอนจาก ' + srcLocName, created_at: now_(), updated_at: now_()
      };
      appendRecord_('Items', destItem);
    }

    appendRecord_('Transactions', {
      id: Utilities.getUuid(), type: 'exchange', item_id: item.id,
      drug_id: drugId, drug_name: drugName,
      from_location_id: srcLocId, from_location_name: srcLocName,
      to_location_id: dest.id, to_location_name: dest.name,
      qty: qty, lot_no: lot, expiry_date: expiry,
      by: user.username, created_at: now_()
    });

    return { status: 'success', message: 'ย้าย ' + drugName + ' ' + qty + ' ไป ' + dest.name + ' แล้ว' };
  } catch (e) {
    logError_('exchangeItem', e);
    return { status: 'error', message: 'ย้ายไม่สำเร็จ ลองอีกครั้ง' };
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function apiRecentExchanges_(limit) {
  var tx = readAll_('Transactions').filter(function (t) { return t.type === 'exchange'; });
  tx.sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
  return { status: 'success', data: tx.slice(0, limit).map(stripMeta_) };
}

// ============================================================ ใบเบิก / ISSUE (stock-out, FIFO ใกล้หมดอายุก่อน)
// ค้นหายาแบบรวมยอดคงเหลือทุก Lot/ทุกจุด เพื่อให้เลือกเบิกในระดับ "ยา"
function apiIssueSearch_(query) {
  var q = String(query || '').trim().toLowerCase();
  if (!q) return { status: 'success', data: [] };
  var items = readAll_('Items').filter(function (it) { return it.status === 'active' && Number(it.qty || 0) > 0; });
  var dmap = {};
  readAll_('Drugs').forEach(function (d) { if (d.id) dmap[d.id] = d; });
  var imgMap = buildDrugImageMap_();
  var agg = {};
  items.forEach(function (it) {
    var d = dmap[it.drug_id] || {};
    var hay = ((it.drug_name || '') + ' ' + (d.code || '')).toLowerCase();
    if (hay.indexOf(q) === -1) return;
    var k = it.drug_id;
    if (!agg[k]) agg[k] = {
      drug_id: it.drug_id, drug_name: it.drug_name, image_url: imgMap[it.drug_id] || '',
      unit: d.unit || '', code: d.code || '', price: Number(d.price || 0), total: 0, lots: 0, min_days: null
    };
    agg[k].total += Number(it.qty || 0);
    agg[k].lots++;
    var days = daysTo_(it.expiry_date);
    if (days != null && (agg[k].min_days == null || days < agg[k].min_days)) agg[k].min_days = days;
  });
  var out = Object.keys(agg).map(function (k) { return agg[k]; });
  out.sort(function (a, b) { return (a.min_days == null ? 1e9 : a.min_days) - (b.min_days == null ? 1e9 : b.min_days); });
  return { status: 'success', data: out.slice(0, 60) };
}

// เบิกออกระดับยา: หักจาก Lot ที่ใกล้หมดอายุก่อน (FIFO) ข้ามจุดได้ บันทึก 1 transaction ต่อ Lot ที่ถูกตัด
function apiIssueItem_(p, user) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);

    var drug = findById_('Drugs', p.drug_id);
    if (!drug) return { status: 'error', message: 'ไม่พบยา' };

    var qty = Number(p.qty);
    if (!qty || qty <= 0) return { status: 'error', message: 'จำนวนต้องมากกว่า 0' };

    var requester = String(p.requester || '').trim();
    if (!requester) return { status: 'error', message: 'กรุณาระบุผู้เบิก' };
    var department = String(p.department || '').trim();
    var note = String(p.note || '').trim();

    var lots = readAll_('Items').filter(function (it) {
      return it.status === 'active' && it.drug_id === drug.id && Number(it.qty || 0) > 0;
    });
    var total = lots.reduce(function (s, it) { return s + Number(it.qty || 0); }, 0);
    if (qty > total) return { status: 'error', message: 'จำนวนเกินกว่าที่มี (คงเหลือ ' + total + ')' };

    // FIFO: ใกล้หมดอายุก่อน, เสมอกันใช้ของที่รับเข้าก่อน
    lots.sort(function (a, b) {
      var da = daysTo_(a.expiry_date), db = daysTo_(b.expiry_date);
      da = (da == null ? 1e9 : da); db = (db == null ? 1e9 : db);
      if (da !== db) return da - db;
      return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });

    var remain = qty, consumed = [], ts = now_();
    for (var i = 0; i < lots.length && remain > 0; i++) {
      var it = lots[i];
      var take = Math.min(remain, Number(it.qty || 0));
      it.qty = Number(it.qty || 0) - take;
      if (it.qty <= 0) { it.qty = 0; it.status = 'used'; }
      it.updated_at = ts;
      updateRecord_('Items', it.id, it);

      appendRecord_('Transactions', {
        id: Utilities.getUuid(), type: 'issue', item_id: it.id,
        drug_id: drug.id, drug_name: drug.name,
        from_location_id: it.location_id, from_location_name: it.location_name,
        to_location_id: '', to_location_name: department,
        qty: take, lot_no: it.lot_no, expiry_date: it.expiry_date,
        reason: 'เบิก', requester: requester, department: department, note: note,
        by: user.username, created_at: ts
      });
      consumed.push({ location_name: it.location_name, lot_no: it.lot_no || '', expiry_date: it.expiry_date, qty: take });
      remain -= take;
    }

    return {
      status: 'success',
      message: 'เบิก ' + drug.name + ' ' + qty + (drug.unit ? ' ' + drug.unit : '') + ' แล้ว',
      consumed: consumed
    };
  } catch (e) {
    logError_('issueItem', e);
    return { status: 'error', message: 'เบิกไม่สำเร็จ ลองอีกครั้ง' };
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function apiRecentIssues_(limit) {
  var tx = readAll_('Transactions').filter(function (t) { return t.type === 'issue'; });
  tx.sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
  var imgMap = buildDrugImageMap_();
  return { status: 'success', data: tx.slice(0, limit).map(function (t) { var o = stripMeta_(t); o.image_url = imgMap[t.drug_id] || ''; return o; }) };
}

// ออกใบเบิก 1 ใบ หลายรายการ → สร้างเลขที่ใบเบิก + หัก FIFO ทุกตัว + เก็บหัวใบไว้กับทุก transaction
function apiIssueSlip_(p, user) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);

    var rawItems = (p && p.items) || [];
    if (!rawItems.length) return { status: 'error', message: 'ยังไม่ได้เลือกยาที่จะเบิก' };

    var requester = String(p.requester || '').trim();
    if (!requester) return { status: 'error', message: 'กรุณาระบุผู้เบิก' };
    var position = String(p.position || '').trim();
    var department = String(p.department || '').trim();
    var receiver = String(p.receiver || '').trim();
    var headNote = String(p.note || '').trim();

    // รวมรายการซ้ำ drug_id เป็นก้อนเดียว
    var mergeMap = {};
    rawItems.forEach(function (line) {
      var k = line.drug_id;
      if (!mergeMap[k]) mergeMap[k] = { drug_id: k, qty: 0, note: String(line.note || '').trim() };
      mergeMap[k].qty += Number(line.qty) || 0;
      if (!mergeMap[k].note && line.note) mergeMap[k].note = String(line.note).trim();
    });

    // ตรวจคงเหลือก่อนทั้งหมด (ยังไม่ตัด) เพื่อกันออกใบครึ่ง ๆ กลาง ๆ
    var allItems = readAll_('Items').filter(function (it) { return it.status === 'active' && Number(it.qty || 0) > 0; });
    var byDrug = {};
    allItems.forEach(function (it) { (byDrug[it.drug_id] = byDrug[it.drug_id] || []).push(it); });

    var plan = [];
    var keys = Object.keys(mergeMap);
    for (var i = 0; i < keys.length; i++) {
      var line = mergeMap[keys[i]];
      var drug = findById_('Drugs', line.drug_id);
      if (!drug) return { status: 'error', message: 'ไม่พบยาบางรายการในระบบ' };
      var qty = Number(line.qty);
      if (!qty || qty <= 0) return { status: 'error', message: 'จำนวนไม่ถูกต้อง: ' + drug.name };
      var lots = (byDrug[drug.id] || []).slice();
      var total = lots.reduce(function (s, it) { return s + Number(it.qty || 0); }, 0);
      if (qty > total) return { status: 'error', message: 'จำนวนเกินคงเหลือ: ' + drug.name + ' (มี ' + total + ')' };
      plan.push({ drug: drug, qty: qty, note: line.note, lots: lots });
    }

    // ออกเลขที่ใบเบิก
    var c = readConfig_();
    var f = c.issue_form || defaultIssueForm_();
    f.seq = (Number(f.seq) || 0) + 1;
    c.issue_form = f;
    writeConfig_(c);
    var beYY = ('0' + ((new Date().getFullYear() + 543) % 100)).slice(-2);
    var slipNo = beYY + '/' + ('0000' + f.seq).slice(-4);

    var ts = now_();
    plan.forEach(function (pl) {
      // FIFO: ใกล้หมดอายุก่อน เสมอกันใช้ของที่รับเข้าก่อน
      pl.lots.sort(function (a, b) {
        var da = daysTo_(a.expiry_date), db = daysTo_(b.expiry_date);
        da = (da == null ? 1e9 : da); db = (db == null ? 1e9 : db);
        if (da !== db) return da - db;
        return String(a.created_at || '').localeCompare(String(b.created_at || ''));
      });
      var remain = pl.qty;
      for (var j = 0; j < pl.lots.length && remain > 0; j++) {
        var it = pl.lots[j];
        var take = Math.min(remain, Number(it.qty || 0));
        it.qty = Number(it.qty || 0) - take;
        if (it.qty <= 0) { it.qty = 0; it.status = 'used'; }
        it.updated_at = ts;
        updateRecord_('Items', it.id, it);

        appendRecord_('Transactions', {
          id: Utilities.getUuid(), type: 'issue', item_id: it.id,
          drug_id: pl.drug.id, drug_name: pl.drug.name,
          from_location_id: it.location_id, from_location_name: it.location_name,
          to_location_id: '', to_location_name: department,
          qty: take, lot_no: it.lot_no, expiry_date: it.expiry_date,
          reason: 'เบิก', slip_no: slipNo,
          requester: requester, position: position, department: department, receiver: receiver,
          note: pl.note || headNote,
          by: user.username, created_at: ts
        });
        remain -= take;
      }
    });

    return { status: 'success', message: 'ออกใบเบิกเลขที่ ' + slipNo + ' แล้ว', slip_no: slipNo };
  } catch (e) {
    logError_('issueSlip', e);
    return { status: 'error', message: 'ออกใบเบิกไม่สำเร็จ ลองอีกครั้ง' };
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// ดึงข้อมูลใบเบิกตามเลขที่ เพื่อนำไปพิมพ์ (รวมรายการต่อยา + คงเหลือปัจจุบัน + หน่วยนับ + ขั้นต่ำ)
function apiGetIssueSlip_(slipNo) {
  slipNo = String(slipNo || '').trim();
  if (!slipNo) return { status: 'error', message: 'ไม่พบเลขที่ใบเบิก' };
  var tx = readAll_('Transactions').filter(function (t) { return t.type === 'issue' && t.slip_no === slipNo; });
  if (!tx.length) return { status: 'error', message: 'ไม่พบใบเบิกนี้' };
  tx.sort(function (a, b) { return String(a.created_at || '').localeCompare(String(b.created_at || '')); });
  var head = tx[0];

  var drugs = {};
  readAll_('Drugs').forEach(function (d) { drugs[d.id] = d; });
  var live = {};
  readAll_('Items').filter(function (it) { return it.status === 'active' && Number(it.qty || 0) > 0; })
    .forEach(function (it) { live[it.drug_id] = (live[it.drug_id] || 0) + Number(it.qty || 0); });

  var lineMap = {}, order = [];
  tx.forEach(function (t) {
    var k = t.drug_id;
    if (!lineMap[k]) { lineMap[k] = { drug_id: k, drug_name: t.drug_name, issued: 0, note: t.note || '' }; order.push(k); }
    lineMap[k].issued += Number(t.qty || 0);
    if (!lineMap[k].note && t.note) lineMap[k].note = t.note;
  });
  var lines = order.map(function (k) {
    var d = drugs[k] || {}, l = lineMap[k];
    l.unit = d.unit || '';
    l.unit_price = Number(d.price || 0);
    l.min_qty = (Number(d.min_qty || 0) > 0) ? Number(d.min_qty) : '';
    l.max_qty = '';
    l.remaining = live[k] || 0;
    return l;
  });

  var c = readConfig_();
  return {
    status: 'success',
    slip: {
      slip_no: slipNo, date: head.created_at,
      requester: head.requester || '', position: head.position || '',
      department: head.department || '', receiver: head.receiver || '',
      note: head.note || '', by: head.by || '', lines: lines
    },
    form: c.issue_form || defaultIssueForm_(),
    hospital_name: c.hospital_name || ''
  };
}

// ============================================================ NOTIFICATIONS (Part 6)
function apiGetNotifyConfig_() {
  var n = readConfig_().notification || {};
  return {
    status: 'success',
    notification: {
      enabled: !!n.enabled,
      channel: n.channel || 'telegram',
      notify_time: n.notify_time || '08:00',
      telegram_chat_id: n.telegram_chat_id || '',
      has_telegram_token: !!n.telegram_bot_token,
      has_line_token: !!n.line_token
    }
  };
}

function apiSaveNotifyConfig_(patch) {
  var c = readConfig_();
  var n = c.notification || {};
  if (patch && typeof patch === 'object') {
    if (patch.enabled !== undefined) n.enabled = !!patch.enabled;
    if (patch.channel !== undefined) n.channel = patch.channel;
    if (patch.notify_time !== undefined) n.notify_time = String(patch.notify_time).trim();
    if (patch.telegram_chat_id !== undefined) n.telegram_chat_id = String(patch.telegram_chat_id).trim();
    if (patch.telegram_bot_token) n.telegram_bot_token = String(patch.telegram_bot_token).trim();
    if (patch.line_token) n.line_token = String(patch.line_token).trim();
    if (patch.clear_telegram_token) n.telegram_bot_token = '';
    if (patch.clear_line_token) n.line_token = '';
  }
  c.notification = n;
  c.updated_at = now_();
  writeConfig_(c);
  try { applyNotifyTrigger_(n); } catch (e) { logError_('applyNotifyTrigger_', e); }
  return { status: 'success', message: 'บันทึกการแจ้งเตือนแล้ว' };
}

function apiTestNotification_() {
  var c = readConfig_();
  var res = sendNotify_(c, '\u2705 ทดสอบการแจ้งเตือนจาก ' + (c.hospital_name || 'The Watcher'));
  if (res && res.ok) return { status: 'success', message: 'ส่งข้อความทดสอบแล้ว' };
  return { status: 'error', message: 'ส่งไม่สำเร็จ: ' + (res ? (res.error || ('HTTP ' + res.code)) : 'ไม่ทราบสาเหตุ') };
}

function checkExpiryAndNotify() {
  try {
    var c = readConfig_();
    if (!c.notification || !c.notification.enabled) return;

    var dash = apiGetDashboard_();
    var s = dash.summary;
    var low = dash.low_stock || [];
    if (s.within35 === 0 && s.within60 === 0 && s.within120 === 0 && s.expired === 0 && low.length === 0) return;

    var tz = Session.getScriptTimeZone();
    var lines = [];
    lines.push('\uD83D\uDD14 ' + (c.hospital_name || 'The Watcher') + ' แจ้งเตือนยาใกล้หมดอายุ');
    lines.push('วันที่ ' + Utilities.formatDate(new Date(), tz, 'dd/MM/yyyy'));
    lines.push('');
    if (s.expired > 0) lines.push('\u26A0\uFE0F หมดอายุแล้ว: ' + s.expired + ' รายการ');
    lines.push('\u2022 ภายใน 35 วัน: ' + s.within35 + ' รายการ');
    lines.push('\u2022 ภายใน 60 วัน: ' + s.within60 + ' รายการ');
    lines.push('\u2022 ภายใน 120 วัน: ' + s.within120 + ' รายการ');
    if (low.length) lines.push('\uD83D\uDCE6 สต็อกต่ำกว่าขั้นต่ำ: ' + low.length + ' รายการ');

    var crit = (dash.near || []).filter(function (x) { return x.days <= 35; }).slice(0, 15);
    if (crit.length) {
      lines.push('');
      lines.push('รายการเร่งด่วน:');
      crit.forEach(function (x) {
        lines.push('- ' + x.drug_name + ' (' + x.location_name + ') ' +
          (x.days < 0 ? 'หมดอายุแล้ว' : 'เหลือ ' + x.days + ' วัน') +
          ' หมดอายุ ' + thaiDate_(x.expiry_date));
      });
    }
    sendNotify_(c, lines.join('\n'));
  } catch (e) {
    logError_('checkExpiryAndNotify', e);
  }
}

function sendNotify_(c, text) {
  var n = c.notification || {};
  var ch = n.channel || 'telegram';
  if (ch === 'line') return sendLine_(n.line_token, text);
  return sendTelegram_(n.telegram_bot_token, n.telegram_chat_id, text);
}

function sendTelegram_(token, chatId, text) {
  if (!token || !chatId) return { ok: false, error: 'ยังไม่ตั้งค่า Telegram (token/chat id)' };
  var url = 'https://api.telegram.org/bot' + token + '/sendMessage';
  var res = UrlFetchApp.fetch(url, { method: 'post', payload: { chat_id: chatId, text: text }, muteHttpExceptions: true });
  return { ok: res.getResponseCode() === 200, code: res.getResponseCode() };
}

function sendLine_(token, text) {
  if (!token) return { ok: false, error: 'ยังไม่ตั้งค่า LINE (channel access token)' };
  var url = 'https://api.line.me/v2/bot/message/broadcast';
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true
  });
  return { ok: res.getResponseCode() === 200, code: res.getResponseCode() };
}

function applyNotifyTrigger_(n) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkExpiryAndNotify') ScriptApp.deleteTrigger(t);
  });
  if (n && n.enabled) {
    var hour = 8;
    if (n.notify_time) { var hh = parseInt(String(n.notify_time).split(':')[0], 10); if (!isNaN(hh)) hour = hh; }
    ScriptApp.newTrigger('checkExpiryAndNotify').timeBased().atHour(hour).everyDays(1).create();
  }
}

/** รันครั้งเดียวหลังตั้งค่าแจ้งเตือน เพื่อสร้าง/อัปเดต trigger รายวัน */
function setupNotifications() {
  var c = readConfig_();
  applyNotifyTrigger_(c.notification || {});
  return 'ตั้งค่า trigger แจ้งเตือนแล้ว';
}

function thaiDate_(dateStr) {
  if (!dateStr) return '-';
  var tz = Session.getScriptTimeZone();
  var d = new Date(String(dateStr) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return dateStr;
  return Utilities.formatDate(d, 'UTC', 'dd/MM/yyyy');
}

// ============================================================ ACCOUNT (Part 6)
function apiChangePassword_(p, user) {
  var oldPw = String(p.old_password || '');
  var newPw = String(p.new_password || '');
  if (newPw.length < 4) return { status: 'error', message: 'รหัสผ่านใหม่ต้องอย่างน้อย 4 ตัวอักษร' };
  var u = findUserByUsername_(user.username);
  if (!u) return { status: 'error', message: 'ไม่พบบัญชีผู้ใช้' };
  if (String(u.password) !== oldPw) return { status: 'error', message: 'รหัสผ่านเดิมไม่ถูกต้อง' };
  u.password = newPw;
  u.updated_at = now_();
  updateRecord_('Users', u.id, u);
  return { status: 'success', message: 'เปลี่ยนรหัสผ่านแล้ว' };
}

// ============================================================ EXPORT (Part 6)
function apiExportData_(p) {
  var kind = p.kind || 'receive';
  var from = String(p.from || '');
  var to = String(p.to || '');
  var tz = Session.getScriptTimeZone();

  function localDate(iso) { try { return Utilities.formatDate(new Date(iso), tz, 'yyyy-MM-dd'); } catch (e) { return ''; } }
  function inRange(d) { if (from && d < from) return false; if (to && d > to) return false; return true; }

  var columns, rows = [];

  if (kind === 'stock') {
    columns = ['ยา', 'สถานที่', 'Lot No.', 'วันหมดอายุ', 'คงเหลือ(วัน)', 'จำนวน', 'รับเข้าโดย', 'รับเข้าเมื่อ'];
    var items = readAll_('Items').filter(function (it) { return it.status === 'active' && Number(it.qty || 0) > 0; });
    items.sort(function (a, b) { return (daysTo_(a.expiry_date) == null ? 1e9 : daysTo_(a.expiry_date)) - (daysTo_(b.expiry_date) == null ? 1e9 : daysTo_(b.expiry_date)); });
    items.forEach(function (it) {
      rows.push([it.drug_name, it.location_name, it.lot_no || '', it.expiry_date || '', daysTo_(it.expiry_date), Number(it.qty || 0), it.received_by || '', it.received_at ? localDate(it.received_at) : '']);
    });
  } else {
    var types = (kind === 'receive') ? ['receive'] : ['receive', 'exchange', 'issue', 'dispose', 'adjust'];
    columns = (kind === 'receive')
      ? ['วันที่', 'เวลา', 'ยา', 'สถานที่', 'Lot No.', 'วันหมดอายุ', 'จำนวน', 'โดย']
      : ['วันที่', 'เวลา', 'ประเภท', 'ยา', 'จาก', 'ไป', 'Lot No.', 'วันหมดอายุ', 'จำนวน', 'เหตุผล', 'โดย'];
    var tx = readAll_('Transactions').filter(function (t) { return types.indexOf(t.type) !== -1; });
    tx = tx.filter(function (t) { return inRange(localDate(t.created_at)); });
    tx.sort(function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)); });
    tx.forEach(function (t) {
      var d = '', tm = '';
      try { d = Utilities.formatDate(new Date(t.created_at), tz, 'dd/MM/yyyy'); tm = Utilities.formatDate(new Date(t.created_at), tz, 'HH:mm'); } catch (e) {}
      if (kind === 'receive') {
        rows.push([d, tm, t.drug_name, t.to_location_name || '', t.lot_no || '', t.expiry_date || '', Number(t.qty || 0), t.by || '']);
      } else {
        var label = t.type === 'receive' ? 'รับเข้า' : (t.type === 'exchange' ? 'ย้าย/แลก' : (t.type === 'issue' ? 'เบิก' : (t.type === 'dispose' ? 'ตัดจ่าย/ทิ้ง' : (t.type === 'adjust' ? 'ปรับยอด' : t.type))));
        var reasonCell = t.reason || '';
        if (t.type === 'issue') {
          reasonCell = 'ผู้เบิก: ' + (t.requester || '-') + (t.department ? ' · หน่วยงาน: ' + t.department : '') + (t.note ? ' · ' + t.note : '');
        }
        rows.push([d, tm, label, t.drug_name, t.from_location_name || '', t.to_location_name || '', t.lot_no || '', t.expiry_date || '', Number(t.qty || 0), reasonCell, t.by || '']);
      }
    });
  }

  var nameMap = { receive: 'รับเข้า', stock: 'สต็อกคงเหลือ', all: 'การเคลื่อนไหว' };
  var fname = 'TheWatcher_' + (nameMap[kind] || kind) + (from ? '_' + from : '') + (to && to !== from ? '_ถึง_' + to : '') + '.xlsx';
  return { status: 'success', columns: columns, rows: rows, filename: fname, count: rows.length };
}

// ============================================================ DISPOSE / HISTORY / USERS (Extra)
function apiDisposeItem_(p, user) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var item = findById_('Items', p.item_id);
    if (!item || item.status !== 'active') return { status: 'error', message: 'ไม่พบรายการยา หรือถูกตัดออกแล้ว' };
    var qty = Number(p.qty);
    if (!qty || qty <= 0) return { status: 'error', message: 'จำนวนต้องมากกว่า 0' };
    if (qty > Number(item.qty || 0)) return { status: 'error', message: 'จำนวนเกินกว่าที่มี (' + item.qty + ')' };
    var reason = String(p.reason || '').trim() || 'อื่นๆ';
    var note = String(p.note || '').trim();

    item.qty = Number(item.qty || 0) - qty;
    if (item.qty <= 0) { item.qty = 0; item.status = (reason === 'เบิกใช้') ? 'used' : 'disposed'; }
    item.updated_at = now_();
    updateRecord_('Items', item.id, item);

    appendRecord_('Transactions', {
      id: Utilities.getUuid(), type: 'dispose', item_id: item.id,
      drug_id: item.drug_id, drug_name: item.drug_name,
      from_location_id: item.location_id, from_location_name: item.location_name,
      to_location_id: '', to_location_name: '',
      qty: qty, lot_no: item.lot_no, expiry_date: item.expiry_date,
      reason: reason, note: note, by: user.username, created_at: now_()
    });
    return { status: 'success', message: 'ตัดจ่าย ' + item.drug_name + ' ' + qty + ' (' + reason + ')' };
  } catch (e) { logError_('disposeItem', e); return { status: 'error', message: 'ตัดจ่ายไม่สำเร็จ' }; }
  finally { try { lock.releaseLock(); } catch (_) {} }
}

function apiGetHistory_(p) {
  var type = String((p && p.type) || '').trim();
  var limit = (p && p.limit) || 60;
  var tx = readAll_('Transactions');
  if (type) tx = tx.filter(function (t) { return t.type === type; });
  tx.sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
  return { status: 'success', data: tx.slice(0, limit).map(stripMeta_) };
}

function apiGetUsers_() {
  var users = readAll_('Users').map(function (u) {
    return { id: u.id, username: u.username, name: u.name, role: u.role, active: u.active !== false, last_login: u.last_login || '' };
  });
  return { status: 'success', data: users };
}

function apiSaveUser_(u, actor) {
  if (!u || !u.username || !String(u.username).trim()) return { status: 'error', message: 'กรุณากรอกชื่อผู้ใช้' };
  var username = String(u.username).trim();
  var role = CONFIG.USER_ROLES[u.role] ? u.role : 'staff';
  var name = (u.name && String(u.name).trim()) || CONFIG.USER_ROLES[role].name;
  var users = readAll_('Users');

  if (u.id) {
    var ex = findById_('Users', u.id);
    if (!ex) return { status: 'error', message: 'ไม่พบผู้ใช้' };
    for (var i = 0; i < users.length; i++) { if (users[i].username === username && users[i].id !== u.id) return { status: 'error', message: 'ชื่อผู้ใช้นี้มีอยู่แล้ว' }; }
    ex.username = username; ex.name = name; ex.role = role; ex.permissions = CONFIG.USER_ROLES[role].permissions;
    if (u.active !== undefined) ex.active = !!u.active;
    if (u.password && String(u.password).length >= 4) ex.password = String(u.password);
    ex.updated_at = now_();
    updateRecord_('Users', u.id, ex);
    return { status: 'success', message: 'บันทึกผู้ใช้แล้ว' };
  }

  for (var j = 0; j < users.length; j++) { if (users[j].username === username) return { status: 'error', message: 'ชื่อผู้ใช้นี้มีอยู่แล้ว' }; }
  if (!u.password || String(u.password).length < 4) return { status: 'error', message: 'ตั้งรหัสผ่านอย่างน้อย 4 ตัวอักษร' };
  appendRecord_('Users', {
    id: Utilities.getUuid(), username: username, password: String(u.password),
    role: role, name: name, permissions: CONFIG.USER_ROLES[role].permissions,
    active: true, last_login: '', created_at: now_(), updated_at: now_()
  });
  return { status: 'success', message: 'เพิ่มผู้ใช้แล้ว' };
}

function apiDeleteUser_(id, actor) {
  var ex = findById_('Users', id);
  if (!ex) return { status: 'error', message: 'ไม่พบผู้ใช้' };
  if (ex.username === actor.username) return { status: 'error', message: 'ลบบัญชีตัวเองไม่ได้' };
  getSheet_('Users').deleteRow(ex._row);
  return { status: 'success', message: 'ลบผู้ใช้แล้ว' };
}

// ============================================================ LOW STOCK / AUDIT (Extra2)
function apiGetLowStock_() {
  var drugs = readAll_('Drugs').filter(activeOnly_).filter(function (d) { return Number(d.min_qty || 0) > 0; });
  if (!drugs.length) return { status: 'success', data: [] };
  var items = readAll_('Items').filter(function (it) { return it.status === 'active' && Number(it.qty || 0) > 0; });
  var totals = {};
  items.forEach(function (it) { totals[it.drug_id] = (totals[it.drug_id] || 0) + Number(it.qty || 0); });
  var out = [];
  drugs.forEach(function (d) {
    var tot = totals[d.id] || 0;
    if (tot < Number(d.min_qty)) {
      out.push({ drug_id: d.id, name: d.name, unit: d.unit || '', min_qty: Number(d.min_qty), total: tot, image_url: d.image_file_id ? imageUrl_(d.image_file_id) : '' });
    }
  });
  out.sort(function (a, b) { return (a.total - a.min_qty) - (b.total - b.min_qty); });
  return { status: 'success', data: out };
}

function apiAdjustItem_(p, user) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var item = findById_('Items', p.item_id);
    if (!item || item.status !== 'active') return { status: 'error', message: 'ไม่พบรายการยา' };
    var actual = Number(p.actual_qty);
    if (isNaN(actual) || actual < 0) return { status: 'error', message: 'จำนวนไม่ถูกต้อง' };
    var before = Number(item.qty || 0);
    if (actual === before) return { status: 'success', message: 'ไม่มีการเปลี่ยนแปลง', unchanged: true };

    item.qty = actual;
    if (actual <= 0) { item.qty = 0; item.status = 'disposed'; }
    item.updated_at = now_();
    updateRecord_('Items', item.id, item);

    appendRecord_('Transactions', {
      id: Utilities.getUuid(), type: 'adjust', item_id: item.id,
      drug_id: item.drug_id, drug_name: item.drug_name,
      from_location_id: item.location_id, from_location_name: item.location_name,
      to_location_id: '', to_location_name: '',
      qty: actual, lot_no: item.lot_no, expiry_date: item.expiry_date,
      reason: 'ตรวจนับ', note: 'ปรับจาก ' + before + ' เป็น ' + actual + (p.note ? ' · ' + p.note : ''),
      by: user.username, created_at: now_()
    });
    return { status: 'success', message: 'ปรับยอด ' + item.drug_name + ' เป็น ' + actual };
  } catch (e) { logError_('adjustItem', e); return { status: 'error', message: 'ปรับยอดไม่สำเร็จ' }; }
  finally { try { lock.releaseLock(); } catch (_) {} }
}

// ============================================================ UTIL
function now_() { return new Date().toISOString(); }

function logError_(where, err) {
  try {
    getSheet_('Errors').appendRow([JSON.stringify({
      id: Utilities.getUuid(),
      where: where,
      message: String(err && err.message ? err.message : err),
      stack: String(err && err.stack ? err.stack : ''),
      created_at: now_()
    })]);
  } catch (e) { /* เงียบไว้ */ }
}
