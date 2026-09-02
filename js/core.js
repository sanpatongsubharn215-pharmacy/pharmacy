/* core.js - หัวใจฝั่ง frontend: boot / auth / นำทาง / หน้าจอ */

const ICONS = {
  box: 'bi-box-seam-fill', bolt: 'bi-lightning-charge-fill', archive: 'bi-archive-fill',
  building: 'bi-building-fill', cart: 'bi-cart-fill', bed: 'bi-hospital',
  asterisk: 'bi-asterisk', people: 'bi-people-fill', injection: 'bi-eyedropper',
  firstaid: 'bi-bag-plus-fill', default: 'bi-geo-alt-fill'
};
function iconClass(key) { return ICONS[key] || ICONS.default; }

/* รูปยา: แสดงรูปจริงถ้ามี ไม่งั้นไอคอนแคปซูล */
function drugThumb(url) {
  return url
    ? `<div class="thumb"><img src="${url}" loading="lazy" alt=""></div>`
    : `<div class="thumb thumb-ph"><i class="bi bi-capsule"></i></div>`;
}

const App = {
  token: localStorage.getItem('tw_token') || '',
  user: null,
  branding: { hospital_name: 'The Watcher', logo_url: '', app_version: '' },
  thresholds: { critical: 35, high: 60, medium: 120 },
  beYear: false,
  tab: 'home',

  setTheme(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    try { localStorage.setItem('tw_theme', dark ? 'dark' : 'light'); } catch (e) {}
    const m = document.querySelector('meta[name=theme-color]');
    if (m) m.setAttribute('content', dark ? '#16241c' : '#2f7a52');
  },
  isDark() { try { return localStorage.getItem('tw_theme') === 'dark'; } catch (e) { return false; } },

  async boot() {
    this.showLoading('กำลังเชื่อมต่อ');
    try {
      try {
        const b = await api('branding');
        if (b && b.branding) { this.branding = b.branding; if (b.branding.thresholds) this.thresholds = b.branding.thresholds; this.beYear = !!b.branding.display_be; }
      } catch (e) { /* แสดง login ได้แม้ branding ล้ม */ }

      this.paintLoginBrand();

      if (this.token) {
        const me = await api('me').catch(() => null);
        if (me && me.status === 'success') {
          this.user = me.user;
          this.enterApp();
          return;
        }
        this.token = '';
        localStorage.removeItem('tw_token');
      }
      this.showLogin();
    } finally {
      this.hideLoading();
    }
  },

  /* ---------- login ---------- */
  paintLoginBrand() {
    const mark = document.querySelector('#login .brandmark');
    mark.innerHTML = this.branding.logo_url
      ? `<img src="${this.branding.logo_url}" alt="logo">`
      : `<i class="bi bi-capsule-pill"></i>`;
    document.querySelector('#login h1').textContent = this.branding.hospital_name || 'The Watcher';
  },

  showLogin() {
    document.getElementById('login').style.display = 'flex';
    document.getElementById('main').classList.add('d-none');
  },

  async doLogin() {
    const u = document.getElementById('liUser').value.trim();
    const p = document.getElementById('liPass').value;
    const err = document.getElementById('liErr');
    const btn = document.getElementById('liBtn');
    err.textContent = '';
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    try {
      const r = await api('login', { username: u, password: p });
      if (r.status === 'success') {
        this.token = r.token; this.user = r.user;
        localStorage.setItem('tw_token', r.token);
        this.enterApp();
      } else {
        err.textContent = r.message || 'เข้าสู่ระบบไม่สำเร็จ';
      }
    } catch (e) {
      err.textContent = e.message || 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้';
    } finally {
      btn.disabled = false; btn.textContent = 'เข้าสู่ระบบ';
    }
  },

  handleAuthExpired() {
    this.token = ''; this.user = null;
    localStorage.removeItem('tw_token');
    this.showLogin();
    this.toast('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 'err');
  },

  async logout() {
    try { await api('logout'); } catch (e) {}
    this.token = ''; this.user = null;
    localStorage.removeItem('tw_token');
    Scanner.stopCamera();
    this.showLogin();
  },

  /* ---------- app shell ---------- */
  enterApp() {
    document.getElementById('login').style.display = 'none';
    document.getElementById('main').classList.remove('d-none');
    this.renderHeader();
    this.navigate('home');
  },

  renderHeader() {
    const box = document.getElementById('hLogo');
    box.innerHTML = this.branding.logo_url
      ? `<img src="${this.branding.logo_url}" alt="logo">`
      : `<i class="bi bi-capsule-pill"></i>`;
    document.getElementById('hTitle').textContent = this.branding.hospital_name || 'The Watcher';
  },

  navigate(tab) {
    Scanner.stopCamera(); // กันกล้องค้างเมื่อสลับหน้า
    this.tab = tab;
    document.querySelectorAll('#bottomNav .nav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    const hSet = document.getElementById('hSettings');
    if (hSet) hSet.classList.toggle('active', tab === 'settings');
    const view = document.getElementById('view');
    const map = {
      home: viewHome, locations: viewLocations, receive: viewReceive,
      issue: viewIssue, exchange: viewExchange, settings: () => Settings.render(view)
    };
    (map[tab] || viewHome)(view);
    window.scrollTo(0, 0);
  },

  /* ---------- toast ---------- */
  toast(msg, type) {
    const host = document.getElementById('toastHost');
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  },

  esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },

  /* ---------- loading + validation ---------- */
  loader(text) {
    return `<div class="loader-block"><span class="spin spin-brand"></span><span>${App.esc(text || 'กำลังโหลด')}</span></div>`;
  },
  showLoading(text) {
    const o = document.getElementById('loadingOverlay');
    if (!o) return;
    o.querySelector('.lo-text').textContent = text || 'กำลังโหลด';
    o.classList.add('show');
  },
  hideLoading() {
    const o = document.getElementById('loadingOverlay');
    if (o) o.classList.remove('show');
  },
  invalid(el, msg) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) { if (msg) App.toast(msg, 'err'); return; }
    el.classList.add('is-invalid');
    el.addEventListener('input', () => el.classList.remove('is-invalid'), { once: true });
    el.addEventListener('change', () => el.classList.remove('is-invalid'), { once: true });
    if (msg) App.toast(msg, 'err');
    try { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
  },

  /* ---------- bottom sheet / modal ---------- */
  openSheet(title, bodyHtml) {
    App.closeSheet();
    const o = document.createElement('div');
    o.className = 'sheet-overlay'; o.id = 'appSheet';
    o.innerHTML = `<div class="sheet"><div class="sheet-head"><span>${App.esc(title)}</span>
      <button class="sheet-x" id="sheetX"><i class="bi bi-x-lg"></i></button></div>
      <div class="sheet-body">${bodyHtml}</div></div>`;
    document.body.appendChild(o);
    o.addEventListener('click', e => { if (e.target === o) App.closeSheet(); });
    o.querySelector('#sheetX').addEventListener('click', () => App.closeSheet());
    requestAnimationFrame(() => o.classList.add('show'));
    return o.querySelector('.sheet-body');
  },
  closeSheet() {
    const o = document.getElementById('appSheet');
    if (o) o.remove();
  }
};

/* ============================ หน้าจอ (พาร์ท 1) ============================ */

function comingSoon(view, title, note) {
  view.innerHTML = `
    <div class="page-title">${App.esc(title)}</div>
    <div class="coming">
      <i class="bi bi-cone-striped"></i>
      <p style="margin:10px 0 0">${App.esc(note)}</p>
    </div>`;
}

/* ---------- หน้าหลัก อยู่ใน js/dashboard.js (global viewHome) ---------- */

/* ---------- ยาแต่ละจุด อยู่ใน js/stock.js (global viewLocations) ---------- */
/* ---------- แลกยา อยู่ใน js/exchange.js (global viewExchange) ---------- */

/* ---------- หน้ารับเข้า อยู่ใน js/receive.js (global viewReceive) ---------- */

/* ---------- helper วันหมดอายุ (ใช้ร่วม part 3-5) ---------- */
function daysToExpiry(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const exp = new Date(dateStr + 'T00:00:00');
  if (isNaN(exp.getTime())) return null;
  return Math.round((exp - today) / 86400000);
}
function expiryBucket(days) {
  const th = (typeof App !== 'undefined' && App.thresholds) || { critical: 35, high: 60, medium: 120 };
  if (days == null) return { key: 'none', label: '-', cls: 'chip-safe' };
  if (days < 0) return { key: 'expired', label: 'หมดอายุแล้ว', cls: 'chip-crit' };
  if (days <= th.critical) return { key: 'critical', label: days + ' วัน', cls: 'chip-crit' };
  if (days <= th.high) return { key: 'high', label: days + ' วัน', cls: 'chip-high' };
  if (days <= th.medium) return { key: 'medium', label: days + ' วัน', cls: 'chip-med' };
  return { key: 'safe', label: days + ' วัน', cls: 'chip-safe' };
}
function fmtDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  let y = d.getFullYear();
  if (typeof App !== 'undefined' && App.beYear) y += 543;
  return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + y;
}
function todayLocal() {
  const d = new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

/* ---------- helper สี ---------- */
function hexToSoft(hex) {
  if (!hex || hex[0] !== '#') return 'var(--brand-soft)';
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},0.13)`;
}

/* ============================ boot ============================ */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('liBtn').addEventListener('click', () => App.doLogin());
  document.getElementById('liPass').addEventListener('keydown', e => { if (e.key === 'Enter') App.doLogin(); });
  document.querySelectorAll('#bottomNav .nav-btn').forEach(b => {
    b.addEventListener('click', () => App.navigate(b.dataset.tab));
  });
  const hSet = document.getElementById('hSettings');
  if (hSet) hSet.addEventListener('click', () => App.navigate('settings'));
  App.boot();
});
