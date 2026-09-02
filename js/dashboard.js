/* dashboard.js - พาร์ท 4: หน้าหลัก (ภาพรวม + ค้นหา + รายการใกล้หมดอายุ) */
const Dashboard = {
  _view: null, _summary: null, _near: [], _byLoc: [], _th: null, _low: [],
  _filter: 'all',   // all | crit | high | med
  _byLocView: false,
  _searching: false, _timer: null,

  async render(view) {
    this._view = view;
    this._filter = 'all'; this._byLocView = false; this._searching = false;
    const today = new Date().toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' });

    view.innerHTML = `
      <div class="d-flex justify-content-between align-items-end" style="margin-bottom:14px">
        <div><div class="page-title" style="margin-bottom:0">ภาพรวม</div>
          <div class="page-sub" style="margin:2px 0 0">${today}</div></div>
      </div>

      <div id="statGrid" class="stat-grid">
        ${this.statSkeleton()}
      </div>

      <div id="valueBox"></div>
      <div id="lowStockBox"></div>

      <div class="search-wrap">
        <i class="bi bi-search"></i>
        <input id="dashSearch" autocomplete="off" placeholder="ค้นหาชื่อยา, สถานที่, Lot">
        <i class="bi bi-x-circle-fill clear" id="dashClear" style="display:none"></i>
      </div>

      <div class="d-flex justify-content-between align-items-center" style="margin:20px 4px 12px">
        <div class="section-label" id="listTitle" style="margin:0">รายการใกล้หมดอายุ</div>
        <button id="byLocToggle" class="link-btn">ดูแยกสถานที่</button>
      </div>
      <div id="dashList">${App.loader()}</div>`;

    this.bindSearch();
    document.getElementById('byLocToggle').addEventListener('click', () => this.toggleByLoc());

    const r = await api('getDashboard').catch(() => null);
    if (!r || r.status !== 'success') {
      document.getElementById('dashList').innerHTML = '<div class="hint">โหลดข้อมูลไม่ได้</div>';
      return;
    }
    this._summary = r.summary; this._near = r.near || []; this._byLoc = r.by_location || [];
    this._th = r.thresholds || App.thresholds;
    this._low = r.low_stock || [];
    this.paintValue(r.total_value);
    this.paintStats();
    this.paintLow();
    this.renderList();
  },

  paintValue(val) {
    const box = document.getElementById('valueBox');
    if (!box) return;
    if (val == null) { box.innerHTML = ''; return; }
    const fmt = n => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    box.innerHTML = `
      <div class="value-banner">
        <div>
          <div class="hint" style="margin:0 0 4px">มูลค่าคลังยารวม</div>
          <div style="font-size:1.45rem;font-weight:700;color:var(--brand-strong);line-height:1.1">฿${fmt(val)}</div>
        </div>
        <i class="bi bi-cash-coin" style="font-size:2rem;opacity:.45"></i>
      </div>`;
  },

  paintLow() {
    const box = document.getElementById('lowStockBox');
    if (!box) return;
    const low = this._low || [];
    if (!low.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<button class="low-banner" id="lowBtn"><i class="bi bi-box-seam-fill"></i><span>สต็อกต่ำกว่าขั้นต่ำ ${low.length} รายการ</span><i class="bi bi-chevron-right"></i></button>`;
    document.getElementById('lowBtn').addEventListener('click', () => this.showLow());
  },

  showLow() {
    const low = this._low || [];
    App.openSheet('ยาสต็อกต่ำ', low.map(d => `
      <div class="scan-row">${drugThumb(d.image_url)}
        <div style="flex:1;min-width:0"><div style="font-weight:600">${App.esc(d.name)}</div>
          <div class="hint" style="margin:2px 0 0">ขั้นต่ำ ${d.min_qty} ${App.esc(d.unit || '')}</div></div>
        <div style="text-align:right"><div class="num" style="color:var(--danger);font-weight:700">${d.total}</div><div class="hint">คงเหลือ</div></div>
      </div>`).join('') || '<div class="hint">ไม่มี</div>');
  },

  statSkeleton() {
    return ['crit', 'high', 'med', 'safe'].map(c => `<div class="stat-card ${c}"><div class="stat-num">-</div></div>`).join('');
  },

  paintStats() {
    const s = this._summary;
    const th = this._th || App.thresholds;
    const cards = [
      { c: 'crit', f: 'crit', icon: 'bi-exclamation-triangle-fill', label: 'ภายใน ' + th.critical + ' วัน', n: s.within35 },
      { c: 'high', f: 'high', icon: 'bi-calendar-event-fill', label: 'ภายใน ' + th.high + ' วัน', n: s.within60 },
      { c: 'med', f: 'med', icon: 'bi-calendar3', label: 'ภายใน ' + th.medium + ' วัน', n: s.within120 },
      { c: 'safe', f: null, icon: 'bi-check2-circle', label: 'มากกว่า ' + th.medium + ' วัน', n: s.over120 }
    ];
    document.getElementById('statGrid').innerHTML = cards.map(c => `
      <button class="stat-card ${c.c} ${c.f ? 'tappable' : ''} ${this._filter === c.f ? 'on' : ''}" data-f="${c.f || ''}">
        <i class="bi ${c.icon} stat-ic"></i>
        <div class="stat-num">${c.n}</div>
        <div class="stat-label">${c.label}</div>
      </button>`).join('');

    document.querySelectorAll('#statGrid .stat-card').forEach(b => b.addEventListener('click', () => {
      const f = b.dataset.f;
      if (!f) { App.toast('ดูรายการระยะยาวในเมนู ยาแต่ละจุด'); return; }
      this._filter = (this._filter === f) ? 'all' : f;
      this._searching = false;
      const si = document.getElementById('dashSearch'); if (si) si.value = '';
      document.getElementById('dashClear').style.display = 'none';
      this._byLocView = false; this.syncByLocBtn();
      this.paintStats(); this.renderList();
    }));
  },

  bindSearch() {
    const input = document.getElementById('dashSearch');
    const clear = document.getElementById('dashClear');
    input.addEventListener('input', () => {
      const q = input.value.trim();
      clear.style.display = q ? 'block' : 'none';
      clearTimeout(this._timer);
      if (!q) { this._searching = false; this.renderList(); return; }
      this._timer = setTimeout(() => this.doSearch(q), 300);
    });
    clear.addEventListener('click', () => { input.value = ''; clear.style.display = 'none'; this._searching = false; this.renderList(); });
  },

  async doSearch(q) {
    this._searching = true;
    document.getElementById('listTitle').textContent = 'ผลการค้นหา';
    document.getElementById('dashList').innerHTML = '<div class="hint">กำลังค้นหา...</div>';
    const r = await api('searchItems', { q }).catch(() => null);
    const list = (r && r.data) || [];
    document.getElementById('dashList').innerHTML = list.length
      ? list.map(it => this.itemRow(it)).join('')
      : '<div class="empty-state"><div class="es-title">ไม่พบรายการ</div><div>ลองคำค้นอื่น</div></div>';
  },

  toggleByLoc() {
    this._byLocView = !this._byLocView;
    this._searching = false;
    const si = document.getElementById('dashSearch'); if (si) si.value = '';
    document.getElementById('dashClear').style.display = 'none';
    this.syncByLocBtn();
    this.renderList();
  },

  syncByLocBtn() {
    const btn = document.getElementById('byLocToggle');
    if (btn) btn.textContent = this._byLocView ? 'ดูเป็นรายการ' : 'ดูแยกสถานที่';
  },

  renderList() {
    const wrap = document.getElementById('dashList');
    const title = document.getElementById('listTitle');
    if (this._searching) return; // doSearch จัดการเอง

    if (this._summary && this._summary.total_items === 0) {
      title.textContent = 'รายการใกล้หมดอายุ';
      wrap.innerHTML = `<div class="empty-state" style="padding:54px 20px">
        <div class="es-icon"><i class="bi bi-capsule"></i></div>
        <div class="es-title">ยังไม่มีรายการยา</div>
        <div>แตะปุ่มรับเข้าเพื่อเพิ่มรายการแรก</div></div>`;
      return;
    }

    if (this._byLocView) {
      title.textContent = 'ใกล้หมดอายุ แยกสถานที่';
      wrap.innerHTML = this._byLoc.length ? this._byLoc.map(l => `
        <div class="menu-item" style="cursor:default">
          <div class="mi-icon"><i class="bi bi-geo-alt-fill"></i></div>
          <div class="mi-body"><div class="mi-title">${App.esc(l.location_name || 'ไม่ระบุ')}</div>
            <div class="mi-desc">ใกล้หมดอายุ ${l.count} รายการ · รวม ${l.qty}</div></div>
          <div class="num" style="color:var(--brand-strong)">${l.count}</div>
        </div>`).join('') : '<div class="hint">ไม่มีรายการใกล้หมดอายุ</div>';
      return;
    }

    // รายการใกล้หมดอายุ (กรองตาม bucket ที่เลือก)
    const th = this._th || App.thresholds;
    const fmap = {
      all: () => true,
      crit: d => d <= th.critical,
      high: d => d > th.critical && d <= th.high,
      med: d => d > th.high && d <= th.medium
    };
    const f = fmap[this._filter] || fmap.all;
    const list = this._near.filter(it => f(it.days));
    const labelMap = {
      all: 'รายการใกล้หมดอายุ',
      crit: 'ใกล้หมดอายุ ภายใน ' + th.critical + ' วัน',
      high: 'ใกล้หมดอายุ ' + (th.critical + 1) + '-' + th.high + ' วัน',
      med: 'ใกล้หมดอายุ ' + (th.high + 1) + '-' + th.medium + ' วัน'
    };
    title.textContent = labelMap[this._filter];
    wrap.innerHTML = list.length ? list.map(it => this.itemRow(it)).join('')
      : `<div class="empty-state"><div class="es-title">ไม่มีรายการในช่วงนี้</div></div>`;
  },

  itemRow(it) {
    const b = expiryBucket(it.days);
    return `<div class="scan-row">
      ${drugThumb(it.image_url)}
      <div style="flex:1;min-width:0">
        <div style="font-weight:600">${App.esc(it.drug_name)}</div>
        <div class="hint" style="margin:2px 0 0">${App.esc(it.location_name || '')} · จำนวน ${it.qty}${it.lot_no ? ' · Lot ' + App.esc(it.lot_no) : ''}</div>
      </div>
      <div style="text-align:right">
        <span class="chip ${b.cls}">${b.label}</span>
        <div class="hint" style="margin:3px 0 0">${fmtDate(it.expiry_date)}</div>
      </div></div>`;
  }
};

function viewHome(view) { Dashboard.render(view); }
