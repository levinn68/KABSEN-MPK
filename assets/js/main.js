(() => {
  const STORAGE_BUCKET = 'attendance-photos';
  const PAYMENT_RPC_NAME = 'treasurer_mark_cash_payment';
  const DAY_MAP = { 1: 'Senin', 2: 'Selasa', 3: 'Rabu', 4: 'Kamis', 5: 'Jumat', 6: 'Sabtu', 7: 'Minggu' };

  const state = {
    db: null,
    currentPage: 'dashboard.html',
    members: [],
    meetings: [],
    weeks: [],
    currentWeek: null,
    selectedCashCycleStart: '',
    selectedRoWeekStart: '',
    weeklyStatus: [],
    attendanceRecent: [],
    faceProfiles: [],
    appSettings: null,
    globalSummary: null,
    roPicketSchedule: [],
    roPicketRecent: [],
    roPicketNotDone: [],
    stream: null,
    realtimeChannel: null,
    realtimeReloadTimer: null,
    manualCashPayments: [],
    cashPaidFacts: [],
    manualFaceProfiles: [],
  };

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    state.currentPage = window.location.pathname.split('/').pop() || 'dashboard.html';
    if (!state.currentPage || state.currentPage === 'index.html') state.currentPage = 'dashboard.html';
    document.body.dataset.page = state.currentPage.replace('.html', '');
    state.db = window.db || null;
    state.manualCashPayments = loadManualCashPayments();
    state.manualFaceProfiles = loadManualFaceProfiles();

    injectRuntimeStyles();
    setupActiveNav();
    setupMobileSidebar();
    setupReveal();
    bindSharedButtons();

    if (!state.db) {
      showToast('Supabase belum siap', 'Isi config.js atau cek koneksi Supabase.', 'error');
      return;
    }

    await primeCoreData();
    subscribeRealtime();

    switch (state.currentPage) {
      case 'index.html':
      case 'dashboard.html':
        await renderDashboardPage();
        break;
      case 'kas.html':
        await renderCashPage();
        break;
      case 'anggota.html':
        await renderMembersPage();
        break;
      case 'rapat.html':
        await renderMeetingsPage();
        await renderAttendancePage();
        break;
      case 'piket-ro.html':
      case 'piket-rom.html':
        await renderRoPicketPage();
        break;
      case 'laporan.html':
        await renderReportsPage();
        break;
      case 'pengaturan.html':
        await renderSettingsPage();
        break;
      default:
        await renderDashboardPage();
        break;
    }
  }


  function loadManualCashPayments() {
    try {
      const raw = window.localStorage.getItem('kabsen.manualCashPayments');
      const parsed = JSON.parse(raw || '[]');
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch (error) {
      console.debug('manualCashPayments parse failed', error);
      return [];
    }
  }

  function saveManualCashPayments() {
    try {
      window.localStorage.setItem('kabsen.manualCashPayments', JSON.stringify(state.manualCashPayments || []));
    } catch (error) {
      console.debug('manualCashPayments save failed', error);
    }
  }

  function upsertManualCashPayment(entry) {
    if (!entry || !entry.member_id || !entry.cycle_start) return;
    const key = `${Number(entry.member_id)}::${String(entry.cycle_start)}`;
    const next = [...(state.manualCashPayments || [])];
    const index = next.findIndex((row) => `${Number(row.member_id)}::${String(row.cycle_start)}` === key);
    if (index >= 0) next[index] = { ...next[index], ...entry };
    else next.unshift(entry);
    state.manualCashPayments = next;
    saveManualCashPayments();
  }

  function getManualCashPayment(memberId, cycleStart) {
    const exact = (state.manualCashPayments || []).find((row) => Number(row.member_id) === Number(memberId) && String(row.cycle_start) === String(cycleStart));
    if (exact) return exact;
    const weekEnd = cycleStart ? addDaysISO(cycleStart, 4) : '';
    const ranged = (state.manualCashPayments || []).find((row) => Number(row.member_id) === Number(memberId) && row.paid_at && cycleStart && String(row.paid_at).slice(0,10) >= String(cycleStart) && String(row.paid_at).slice(0,10) <= String(weekEnd));
    return ranged || null;
  }

  function loadManualFaceProfiles() {
    try {
      const raw = window.localStorage.getItem('kabsen.manualFaceProfiles');
      const parsed = JSON.parse(raw || '[]');
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch (error) {
      console.debug('manualFaceProfiles parse failed', error);
      return [];
    }
  }

  function saveManualFaceProfiles() {
    try {
      window.localStorage.setItem('kabsen.manualFaceProfiles', JSON.stringify(state.manualFaceProfiles || []));
    } catch (error) {
      console.debug('manualFaceProfiles save failed', error);
    }
  }

  function upsertManualFaceProfile(entry) {
    if (!entry || !entry.member_id) return;
    const next = [...(state.manualFaceProfiles || [])];
    const index = next.findIndex((row) => Number(row.member_id) === Number(entry.member_id));
    if (index >= 0) next[index] = { ...next[index], ...entry };
    else next.unshift(entry);
    state.manualFaceProfiles = next;
    saveManualFaceProfiles();
  }

  function derivePaidCashFields(baseRow, memberId, cycleStart) {
    const member = findMember(memberId) || { id: memberId, full_name: baseRow?.full_name || '-' };
    const source = { ...buildDefaultCashRow(member, cycleStart), ...(baseRow || {}) };
    const paidBase = Number(source.paid_base_amount || source.base_amount || state.appSettings?.weekly_fee || 0);
    const paidFine = Number(source.paid_fine_amount || source.current_fine_amount || 0);
    const paidTotal = Number(source.paid_amount || (paidBase + paidFine) || 0);
    return {
      ...source,
      is_paid: true,
      paid_base_amount: paidBase,
      paid_fine_amount: paidFine,
      paid_amount: paidTotal,
      outstanding_total_today: 0,
      current_fine_amount: 0,
      current_late_days: 0,
      paid_at: source.paid_at || new Date().toISOString(),
      status: 'paid',
    };
  }

  function upsertCashPaidFact(row) {
    if (!row || !row.member_id) return;
    const key = `${Number(row.member_id)}::${String(row.cycle_start || '')}::${String(row.paid_at || '')}`;
    const next = new Map((state.cashPaidFacts || []).map((item) => [`${Number(item.member_id)}::${String(item.cycle_start || '')}::${String(item.paid_at || '')}`, item]));
    next.set(key, row);
    state.cashPaidFacts = Array.from(next.values()).sort((a, b) => new Date(b.paid_at || 0).getTime() - new Date(a.paid_at || 0).getTime());
  }

  function getCashPaidFactRows() {
    const factMap = new Map();
    const pushRow = (row) => {
      if (!row || !row.member_id) return;
      const looksPaid = Boolean(row.is_paid) || Boolean(row.paid_at) || Number(row.paid_amount || 0) > 0 || Number(row.paid_base_amount || 0) > 0;
      if (!looksPaid) return;
      const paidKey = row.paid_at ? String(row.paid_at).slice(0, 19) : '';
      const key = `${Number(row.member_id)}::${String(row.cycle_start || '')}::${paidKey}`;
      const existing = factMap.get(key);
      if (!existing || new Date(row.paid_at || 0).getTime() >= new Date(existing.paid_at || 0).getTime()) factMap.set(key, row);
    };
    (state.cashPaidFacts || []).forEach(pushRow);
    (state.manualCashPayments || []).forEach(pushRow);
    (state.weeklyStatus || []).forEach(pushRow);
    return Array.from(factMap.values()).sort((a, b) => new Date(b.paid_at || 0).getTime() - new Date(a.paid_at || 0).getTime());
  }

  function normalizeCashFactRow(row = {}) {
    if (!row || !row.member_id) return null;
    const paidAt = row.paid_at || row.created_at || row.updated_at || row.inserted_at || row.scanned_at || null;
    const cycleStart = row.cycle_start || (paidAt ? getWeekMondayISO(String(paidAt).slice(0, 10)) : '');
    const paidBase = Number(row.paid_base_amount ?? row.base_amount ?? 0);
    const paidFine = Number(row.paid_fine_amount ?? row.fine_amount ?? 0);
    const paidAmount = Number(row.paid_amount ?? row.total_amount ?? row.amount ?? (paidBase + paidFine) ?? 0);
    const status = String(row.status || '').toLowerCase();
    const isPaid = row.is_paid === true || Boolean(paidAt) || status === 'paid' || status === 'lunas' || paidAmount > 0;
    return {
      ...row,
      member_id: Number(row.member_id),
      cycle_start: cycleStart,
      paid_at: paidAt,
      paid_base_amount: paidBase,
      paid_fine_amount: paidFine,
      paid_amount: paidAmount,
      is_paid: isPaid,
    };
  }

  async function fetchCashPaidFactsFromTables() {
    if (!state.db) return [];
    const tables = ['payments', 'cash_payments', 'member_payments', 'weekly_payments'];
    const settled = await Promise.all(tables.map(async (table) => {
      try {
        const { data, error } = await state.db.from(table).select('*').limit(500);
        if (error) return [];
        return Array.isArray(data) ? data : [];
      } catch (error) {
        console.debug(`cash facts skip ${table}`, error?.message || error);
        return [];
      }
    }));
    return settled.flat().map(normalizeCashFactRow).filter((row) => row && row.member_id && row.is_paid);
  }

  function mergeCashFactRows(rows = []) {
    const map = new Map();
    rows.map(normalizeCashFactRow).filter(Boolean).forEach((row) => {
      const paidKey = row.paid_at ? String(row.paid_at).slice(0, 19) : '';
      const key = `${Number(row.member_id)}::${String(row.cycle_start || '')}::${paidKey}`;
      const existing = map.get(key);
      if (!existing || new Date(row.paid_at || 0).getTime() >= new Date(existing.paid_at || 0).getTime()) {
        map.set(key, row);
      }
    });
    return Array.from(map.values()).sort((a, b) => new Date(b.paid_at || 0).getTime() - new Date(a.paid_at || 0).getTime());
  }

  function injectRuntimeStyles() {
    if ($('#runtime-kabsen-style')) return;
    const style = document.createElement('style');
    style.id = 'runtime-kabsen-style';
    style.textContent = `
      .mobile-menu-btn,.sidebar-overlay,.mobile-nav-sheet{display:none!important;}
      .mobile-brandbar{position:fixed;left:12px;right:12px;top:12px;z-index:1190;display:none;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-radius:24px;background:linear-gradient(180deg, rgba(10,17,33,.96), rgba(20,31,55,.92));border:1px solid rgba(212,175,55,.22);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);box-shadow:0 18px 40px rgba(4,8,16,.24);}
      .mobile-brandbar__home{display:flex;align-items:center;gap:12px;min-width:0;flex:1 1 auto;text-decoration:none;}
      .mobile-brandbar__logo{width:38px;height:38px;border-radius:12px;object-fit:cover;box-shadow:0 8px 20px rgba(0,0,0,.22);}
      .mobile-brandbar__text{display:flex;flex-direction:column;line-height:1.05;min-width:0;overflow:hidden;}
      .mobile-brandbar__text strong{display:block;font-family:'Orbitron','Inter',sans-serif;font-size:14px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#f5c94b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .mobile-brandbar__text small{display:block;margin-top:4px;font-size:9px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,244,212,.84);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .mobile-menu-fab{position:relative;z-index:1;flex:0 0 48px;width:48px;height:48px;border-radius:16px;border:1px solid rgba(234,185,54,.18);background:linear-gradient(180deg, rgba(18,27,48,.78), rgba(9,13,24,.88));display:none;align-items:center;justify-content:center;color:#f5c94b;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.05);}
      .mobile-menu-fab span,.mobile-menu-fab span::before,.mobile-menu-fab span::after{display:block;width:18px;height:2px;border-radius:999px;background:currentColor;position:relative;content:'';}
      .mobile-menu-fab span::before{position:absolute;top:-6px;left:0;}
      .mobile-menu-fab span::after{position:absolute;top:6px;left:0;}
      .mobile-drawer{position:fixed;inset:0;z-index:1250;display:none;}
      .mobile-drawer.open{display:block;}
      .mobile-drawer__backdrop{position:absolute;inset:0;background:rgba(3,8,18,.5);backdrop-filter:blur(4px);}
      .mobile-drawer__panel{position:absolute;left:12px;right:12px;top:78px;width:auto;padding:16px;border-radius:24px;background:linear-gradient(180deg, rgba(8,12,24,.98), rgba(12,18,34,.96));border:1px solid rgba(234,185,54,.18);box-shadow:0 24px 44px rgba(4,8,16,.32);display:grid;gap:10px;}
      .mobile-drawer__panel a{display:flex;align-items:center;min-height:50px;padding:0 14px;border-radius:14px;color:#fff1c1;text-decoration:none;font-weight:700;background:rgba(255,255,255,.03);}
      .mobile-drawer__panel a.active{background:rgba(234,185,54,.14);}
      .is-reveal{opacity:0;transform:translateY(18px);transition:opacity .35s ease, transform .35s ease;}
      .is-reveal.is-visible{opacity:1;transform:translateY(0);}
      .live-toast-stack{position:fixed;right:18px;bottom:96px;display:grid;gap:10px;z-index:1800;}
      .live-toast{min-width:260px;max-width:min(92vw,360px);padding:14px 16px;border-radius:18px;color:#f5f8ff;background:linear-gradient(135deg, rgba(8,17,32,.96), rgba(25,46,84,.94));border:1px solid rgba(126,160,255,.22);box-shadow:0 20px 45px rgba(8,17,32,.28);transform:translateY(16px);opacity:0;transition:.24s ease;}
      .live-toast.is-show{transform:translateY(0);opacity:1;}
      .live-toast strong{display:block;margin-bottom:4px;font-size:.95rem;}
      .live-toast span{color:rgba(236,241,255,.78);font-size:.88rem;line-height:1.45;}
      .app-modal-backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(4,8,16,.62);backdrop-filter:blur(9px);z-index:1700;animation:fadeIn .2s ease;}
      .app-modal{width:min(100%, 560px);max-height:min(88vh, 860px);overflow:auto;border-radius:28px;padding:24px;background:linear-gradient(180deg, rgba(10,17,33,.98), rgba(17,28,49,.96));box-shadow:0 30px 90px rgba(8,17,32,.34);border:1px solid rgba(241,189,64,.18);color:#fff6dc;}
      .app-modal.large{width:min(100%, 720px);}
      .app-modal h3{margin:0 0 6px;font-size:1.35rem;color:#fff2c5;}
      .app-modal p{margin:0 0 18px;color:rgba(255,240,199,.76);line-height:1.55;}
      .app-modal .form-grid{display:grid;gap:14px;grid-template-columns:repeat(2, minmax(0,1fr));}
      .app-modal .form-grid .full{grid-column:1 / -1;}
      .app-modal .form-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px;}
      .app-modal label{display:grid;gap:8px;font-weight:700;color:#ffe9a5;}
      .app-modal input,.app-modal textarea,.app-modal select{width:100%;border:1px solid rgba(241,189,64,.18);background:rgba(255,248,233,.98);border-radius:16px;padding:13px 14px;font:inherit;color:#11213f;outline:none;transition:border-color .2s ease, box-shadow .2s ease;}
      .app-modal input:focus,.app-modal textarea:focus,.app-modal select:focus{border-color:rgba(241,189,64,.48);box-shadow:0 0 0 4px rgba(241,189,64,.12);}
      .modal-inline-error{display:none;margin-top:4px;color:#fecaca;font-size:.88rem;}
      .modal-inline-error.is-show{display:block;}
      .modal-danger-summary{margin:16px 0 18px;padding:16px 18px;border-radius:20px;background:linear-gradient(180deg, rgba(118,18,24,.22), rgba(70,11,16,.18));border:1px solid rgba(248,113,113,.18);}
      .modal-danger-summary strong{display:block;margin-bottom:6px;color:#fff2c5;font-size:1rem;}
      .modal-danger-summary span{display:block;color:rgba(255,232,232,.82);line-height:1.6;}
      .title-accent{color:inherit;background:none;-webkit-background-clip:initial;background-clip:initial;}
      @keyframes fadeIn{from{opacity:0}to{opacity:1}}
      @media (max-width:980px){
        .mobile-brandbar,.mobile-menu-fab{display:flex;}
        .sidebar{display:none!important;}
        body.is-sidebar-open{overflow:hidden;}
        .app-shell,.compact-shell{grid-template-columns:1fr!important;width:min(1480px, calc(100% - 20px));margin-top:98px!important;}
        .main-content{padding-top:10px!important;}
      }
      @media (max-width:640px){
        .app-modal{padding:20px;border-radius:24px;}
        .app-modal .form-grid{grid-template-columns:1fr;}
        .app-modal .form-actions{flex-direction:column-reverse;}
        .app-modal .form-actions .btn{width:100%;justify-content:center;}
      }
    `;
    document.head.appendChild(style);
  }

  function setupActiveNav() {
    const current = state.currentPage;
    $$('.nav-link').forEach((link) => {
      const href = (link.getAttribute('href') || '').replace('./', '');
      link.classList.toggle('active', href === current);
    });
    $$('.topbar h1, .page-header h1').forEach((el) => el.classList.add('title-accent'));
  }

  function setupMobileSidebar() {
    if ($('#mobileBottomDock')) return;
    const links = [
      { href: './dashboard.html', label: 'Dashboard', short: 'Home', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.8 12 4l9 6.8v8.2a1 1 0 0 1-1 1h-5.6v-6.1H9.6V20H4a1 1 0 0 1-1-1z"/></svg>' },
      { href: './kas.html', label: 'Kas', short: 'Kas', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm0 3h16M7.5 15.2h.01M11 15.2h2.8"/></svg>' },
      { href: './rapat.html', label: 'Rapat', short: 'Rapat', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3v3M17 3v3M4 8h16M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm2 6h3m2 0h3m-8 4h8"/></svg>' },
      { href: './piket-rom.html', label: 'Piket ROM', short: 'ROM', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 2.7 7.9 7 10 4.3-2.1 7-5.5 7-10V6l-7-3zm0 5.2a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm0 9.2c-1.8-.9-3-2.2-3.8-4 .9-.8 2.2-1.2 3.8-1.2s2.9.4 3.8 1.2c-.8 1.8-2 3.1-3.8 4z"/></svg>' },
      { href: './anggota.html', label: 'Anggota', short: 'Anggota', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0-0.001-8.001A4 4 0 0 0 12 12Zm-7 8a7 7 0 0 1 14 0"/></svg>' },
    ];
    const dock = document.createElement('nav');
    dock.id = 'mobileBottomDock';
    dock.className = 'mobile-bottom-dock';
    dock.setAttribute('aria-label', 'Navigasi utama');
    dock.innerHTML = `<div class="mobile-bottom-dock__inner">${links.map((item) => {
      const active = item.href.replace('./', '') === state.currentPage ? 'active' : '';
      return `<a href="${item.href}" class="mobile-bottom-dock__link ${active}" aria-label="${item.label}"><span class="mobile-bottom-dock__icon">${item.icon}</span><span class="mobile-bottom-dock__text">${item.short}</span></a>`;
    }).join('')}</div>`;
    document.body.appendChild(dock);

    if (!document.getElementById('mobileBrandBar')) {
      const brand = document.createElement('div');
      brand.id = 'mobileBrandBar';
      brand.className = 'mobile-brandbar';
      brand.innerHTML = `<a class="mobile-brandbar__home" href="./dashboard.html"><img class="mobile-brandbar__logo" src="./media/mpk.jpg" alt="MPK Zone"><div class="mobile-brandbar__text"><strong>MPK ZONE</strong><small>SMP TUNAS HARAPAN</small></div></a><button type="button" id="mobileMenuFab" class="mobile-menu-fab" aria-label="Buka menu"><span></span></button>`;
      document.body.appendChild(brand);

      const drawer = document.createElement('div');
      drawer.id = 'mobileDrawer';
      drawer.className = 'mobile-drawer';
      drawer.innerHTML = `<div class="mobile-drawer__backdrop"></div><div class="mobile-drawer__panel">${links.map((item) => {
        const active = item.href.replace('./', '') === state.currentPage ? 'active' : '';
        return `<a href="${item.href}" class="${active}">${item.label}</a>`;
      }).join('')}</div>`;
      document.body.appendChild(drawer);
      $('#mobileMenuFab', brand)?.addEventListener('click', () => drawer.classList.toggle('open'));
      $('.mobile-drawer__backdrop', drawer)?.addEventListener('click', () => drawer.classList.remove('open'));
    }
  }

  function setupReveal() {
    const targets = $$('.hero-panel, .stat-card, .panel, .member-card, .timeline-card, .shortcut-card, .camera-panel, .toolbar-panel, .setting-item, .picket-session-card');
    if (!targets.length) return;
    targets.forEach((el, index) => {
      el.classList.add('is-reveal');
      el.style.transitionDelay = `${Math.min(index * 40, 260)}ms`;
    });
    const observer = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        obs.unobserve(entry.target);
      });
    }, { threshold: 0.08 });
    targets.forEach((el) => observer.observe(el));
  }

  function bindSharedButtons() {
    const exportMap = {
      btnDashboardExport: 'dashboard-export.csv',
      btnExportExcel: 'laporan-kabsen.csv',
      btnExportPdf: 'laporan-kabsen.csv',
    };
    Object.entries(exportMap).forEach(([id, filename]) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('click', () => exportCurrentPageTable(filename));
    });
  }

  async function primeCoreData() {
    const [membersRes, meetingsRes, settingsRes, globalRes, weeksRes, attendanceRes, faceRes, paidFactsRes, roScheduleRes, roRecentRes, roNotDoneRes, tableCashFacts] = await Promise.all([
      state.db.from('members').select('*').order('id', { ascending: true }),
      state.db.from('meetings').select('*').order('meeting_date', { ascending: false }).order('id', { ascending: false }),
      state.db.from('app_settings').select('*').single(),
      state.db.from('v_cash_global_summary').select('*').single(),
      state.db.from('v_cash_weekly_summary').select('*').order('cycle_start', { ascending: false }),
      state.db.from('attendance').select('id, scanned_at, matched, confidence, member_id, meeting_id, members(full_name), meetings(title)').order('scanned_at', { ascending: false }).limit(500),
      state.db.from('face_profiles').select('id, member_id'),
      state.db.from('v_cash_member_weekly_status').select('*').eq('is_paid', true).not('paid_at', 'is', null).order('paid_at', { ascending: false }).limit(500),
      state.db.from('v_ro_picket_schedule').select('*').order('duty_date', { ascending: false }),
      state.db.from('v_ro_picket_recent_scans').select('*').order('scanned_at', { ascending: false }).limit(500),
      state.db.from('v_ro_picket_not_done').select('*').order('duty_date', { ascending: false }).limit(500),
      fetchCashPaidFactsFromTables(),
    ]);

    if (membersRes.error) console.error(membersRes.error);
    if (meetingsRes.error) console.error(meetingsRes.error);
    if (settingsRes.error) console.error(settingsRes.error);
    if (globalRes.error) console.error(globalRes.error);
    if (weeksRes.error) console.error(weeksRes.error);
    if (attendanceRes.error) console.error(attendanceRes.error);
    if (faceRes.error) console.error(faceRes.error);
    if (paidFactsRes.error) console.error(paidFactsRes.error);
    if (roScheduleRes.error) console.error(roScheduleRes.error);
    if (roRecentRes.error) console.error(roRecentRes.error);
    if (roNotDoneRes.error) console.error(roNotDoneRes.error);

    state.members = membersRes.data || [];
    state.meetings = meetingsRes.data || [];
    state.appSettings = settingsRes.data || null;
    state.globalSummary = globalRes.data || null;
    state.weeks = (weeksRes.data || []).slice().sort((a, b) => String(a.cycle_start).localeCompare(String(b.cycle_start)));
    state.currentWeek = resolveActiveCashWeek(state.weeks);
    state.selectedCashCycleStart = state.currentWeek?.cycle_start || state.selectedCashCycleStart || '';
    state.attendanceRecent = attendanceRes.data || [];
    const roRecentRows = roRecentRes.data || [];
    const faceMap = new Map();
    [...(faceRes.data || []), ...(state.manualFaceProfiles || [])].forEach((row) => { if (row && row.member_id) faceMap.set(Number(row.member_id), { id: row.id || `local-${row.member_id}`, member_id: Number(row.member_id) }); });
    state.attendanceRecent.forEach((row) => { if (row && row.member_id) faceMap.set(Number(row.member_id), { id: `scan-${row.member_id}`, member_id: Number(row.member_id) }); });
    roRecentRows.forEach((row) => { if (row && row.member_id) faceMap.set(Number(row.member_id), { id: `ro-${row.member_id}`, member_id: Number(row.member_id) }); });
    state.faceProfiles = Array.from(faceMap.values());
    state.cashPaidFacts = mergeCashFactRows([...(paidFactsRes.data || []), ...(tableCashFacts || []), ...(state.manualCashPayments || [])]);
    state.roPicketSchedule = roScheduleRes.data || [];
    state.roPicketRecent = roRecentRows;
    state.roPicketNotDone = roNotDoneRes.data || [];

    if (state.currentWeek?.cycle_start) {
      const weeklyRes = await state.db
        .from('v_cash_member_weekly_status')
        .select('*')
        .eq('cycle_start', state.currentWeek.cycle_start)
        .order('member_id', { ascending: true });
      if (weeklyRes.error) console.error(weeklyRes.error);
      state.weeklyStatus = buildCashDisplayRows(weeklyRes.data || [], state.currentWeek.cycle_start);
    } else {
      state.weeklyStatus = buildCashDisplayRows([], '');
    }
  }

  function subscribeRealtime() {
    if (!state.db) return;
    state.realtimeChannel = state.db
      .channel(`kabsen-live-${state.currentPage}`)
      .on('postgres_changes', { event: '*', schema: 'public' }, () => {
        clearTimeout(state.realtimeReloadTimer);
        state.realtimeReloadTimer = setTimeout(async () => {
          await primeCoreData();
          await rerenderCurrentPage();
          setSystemStatus('Online', 'Data baru masuk dan tampilan sudah disegarkan otomatis.', 'success');
        }, 500);
      })
      .subscribe();
  }

  async function rerenderCurrentPage() {
    switch (state.currentPage) {
      case 'index.html': return renderDashboardPage();
      case 'kas.html': return renderCashPage(true);
      case 'anggota.html': return renderMembersPage(true);
      case 'rapat.html': return renderMeetingsPage(true);
      case 'piket-ro.html':
      case 'piket-rom.html': return renderRoPicketPage(true);
      case 'laporan.html': return renderReportsPage(true);
      case 'pengaturan.html': return renderSettingsPage(true);
      default: return renderDashboardPage(true);
    }
  }

  function setSystemStatus(title, description, mode = 'success') {
    const card = $('#systemStatusCard');
    if (!card) return;
    const titleEl = $('h3', card);
    const descEl = $('p', card);
    const pill = $('.pill', card);
    if (titleEl) titleEl.textContent = title;
    if (descEl) descEl.textContent = description;
    if (pill) {
      pill.textContent = mode === 'success' ? 'Online' : mode === 'warning' ? 'Perhatian' : 'Offline';
      pill.className = `pill ${mode === 'success' ? 'success' : mode === 'warning' ? 'warning' : 'danger'}`;
    }
  }

  async function renderDashboardPage() {
    renderDashboardHero();
    renderDashboardStats();
    renderDashboardWeeklyChart();
    renderDashboardAlerts();
    await renderDashboardRecentPayments();
    setSystemStatus('Semua sinkron', `Database live aktif. ${state.members.length} anggota, ${state.meetings.length} sesi rapat, ${state.attendanceRecent.length} log terbaru.`, 'success');
  }

  function renderDashboardHero() {
    const metrics = $('#dashboardHeroMetrics');
    if (!metrics || !state.globalSummary) return;
    const week = state.currentWeek;
    const cashSummary = summarizeCashRows(state.weeklyStatus, week?.cycle_start || '');
    const outstandingMembers = cashSummary.outstandingMembers;
    const presentTotal = state.attendanceRecent.filter((row) => row.matched).length;
    const attendancePct = state.members.length ? Math.round((presentTotal / Math.max(state.members.length, 1)) * 100) : 0;

    metrics.innerHTML = `
      <article class="metric-card featured">
        <span>Total Saldo Kas</span>
        <strong>${formatMoney(state.globalSummary.grand_total_collected)}</strong>
        <small>${week ? `Periode ${formatSchoolWeekLabel(week.cycle_start)}` : 'Belum ada minggu aktif'}</small>
      </article>
      <article class="metric-card">
        <span>Tunggakan Aktif</span>
        <strong>${formatMoney(cashSummary.outstandingActive)}</strong>
        <small>${cashSummary.isDue ? `${outstandingMembers} anggota belum lunas` : 'Belum masuk masa tunggakan'}</small>
      </article>
      <article class="metric-card">
        <span>Kehadiran Log Terbaru</span>
        <strong>${attendancePct}%</strong>
        <small>${presentTotal} scan cocok dari ${state.attendanceRecent.length} log terakhir</small>
      </article>
    `;
  }

  function renderDashboardStats() {
    const grid = $('#dashboardStatsGrid');
    if (!grid || !state.globalSummary) return;
    grid.innerHTML = `
      <article class="stat-card"><span class="stat-label">Kas Pokok</span><strong>${formatMoney(state.globalSummary.cash_total_collected)}</strong><small>Akumulasi pembayaran pokok</small></article>
      <article class="stat-card"><span class="stat-label">Denda Masuk</span><strong>${formatMoney(state.globalSummary.fine_total_collected)}</strong><small>Masuk dari pembayaran terlambat</small></article>
      <article class="stat-card"><span class="stat-label">Anggota Aktif</span><strong>${state.members.filter((m) => m.is_active !== false).length}</strong><small>Total member yang masih aktif</small></article>
      <article class="stat-card"><span class="stat-label">Rapat Tercatat</span><strong>${state.meetings.length}</strong><small>${state.meetings.filter((m) => m.is_open).length} sesi masih dibuka</small></article>
    `;
  }

  function renderDashboardWeeklyChart() {
    const wrap = $('#weeklyChartBars');
    if (!wrap) return;
    const top = state.weeks.slice(0, 5).reverse();
    if (!top.length) {
      wrap.innerHTML = `<div class="empty-state">Belum ada data mingguan.</div>`;
      return;
    }
    const max = Math.max(...top.map((row) => Number(row.total_collected || 0)), 1);
    wrap.innerHTML = top.map((row, index) => {
      const ratio = Math.max(14, Math.round((Number(row.total_collected || 0) / max) * 100));
      return `<div><span>W${top.length - index}</span><i style="height:${ratio}%"></i></div>`;
    }).join('');
  }

  function renderDashboardAlerts() {
    const list = $('#dashboardAlertList');
    if (!list) return;
    const cashSummary = summarizeCashRows(state.weeklyStatus, state.currentWeek?.cycle_start || '');
    const unpaid = cashSummary.isDue ? cashSummary.outstandingMembers : 0;
    const unknownFaces = state.attendanceRecent.filter((row) => !row.matched).length;
    const openMeetings = state.meetings.filter((row) => row.is_open).length;
    const newFaces = Math.max(state.faceProfiles.length - new Set(state.faceProfiles.map((f) => f.member_id)).size, 0);
    const items = [
      { title: `${unpaid} anggota belum bayar`, text: cashSummary.isDue ? 'Pantau tunggakan berdasarkan minggu aktif.' : 'Belum masuk masa tunggakan minggu aktif.' },
      { title: `${openMeetings} sesi rapat masih terbuka`, text: 'Tutup sesi bila absensi sudah selesai direkap.' },
      { title: `${unknownFaces} scan butuh validasi`, text: 'Log attendance yang belum cocok perlu dicek manual.' },
      { title: `${newFaces} wajah tambahan tersimpan`, text: 'Profil wajah baru siap dipakai untuk absensi berikutnya.' },
    ];
    list.innerHTML = items.map((item) => `<li><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.text)}</span></li>`).join('');
  }

  async function renderDashboardRecentPayments() {
    const tbody = $('#dashboardRecentPayments');
    if (!tbody) return;
    const recentRows = getCashPaidFactRows().slice(0, 6);

    tbody.innerHTML = recentRows.length ? recentRows.map((row) => `
      <tr>
        <td>${escapeHtml(row.full_name || findMember(row.member_id)?.full_name || '-')}</td>
        <td>${(() => { const paidDate = row.paid_at ? String(row.paid_at).slice(0,10) : ''; const paidWeek = paidDate ? getCashWeekMeta(getWeekMondayISO(paidDate)) : null; return paidWeek ? formatSchoolWeekLabel(paidWeek.cycle_start) : (row.cycle_start ? formatSchoolWeekLabel(row.cycle_start) : (state.currentWeek ? formatSchoolWeekLabel(state.currentWeek.cycle_start) : '-')); })()}</td>
        <td><span class="pill success">Lunas</span></td>
        <td>${formatMoney(row.paid_amount || row.outstanding_total_today || row.base_amount || 0)}</td>
      </tr>
    `).join('') : `<tr><td colspan="4">Belum ada pembayaran terbaru.</td></tr>`;
  }

  function formatSchoolWeekLabel(cycleStart) {
    if (!cycleStart) return '-';
    const friday = addDaysISO(cycleStart, 4);
    const meta = getCashWeekMeta(cycleStart);
    return `${meta?.sequence_label ? `${meta.sequence_label} - ` : ''}${formatDate(cycleStart)} - ${formatDate(friday)}`;
  }

async function renderCashPage(isRealtime = false) {
    renderCashStats();
    renderCashRules();
    fillCashForm();
    bindCashActions();
    await renderCashStatusTable();
    if (isRealtime) showToast('Kas diperbarui', 'Perubahan pembayaran terbaru sudah masuk ke tampilan.', 'success');
  }

  function renderCashStats() {
    const grid = $('#cashStatsGrid');
    if (!grid || !state.appSettings) return;
    const cashSummary = summarizeCashRows(state.weeklyStatus, state.currentWeek?.cycle_start || '');
    const unpaid = cashSummary.isDue ? cashSummary.outstandingMembers : 0;
    grid.innerHTML = `
      <article class="stat-card"><span class="stat-label">Tarif Kas</span><strong>${formatMoney(state.appSettings.weekly_fee)}</strong><small>Per anggota / minggu</small></article>
      <article class="stat-card"><span class="stat-label">Denda Harian</span><strong>${formatMoney(state.appSettings.fine_per_day)}</strong><small>Mulai setelah ${DAY_MAP[state.appSettings.safe_until_dow] || 'hari aman'}</small></article>
      <article class="stat-card"><span class="stat-label">Anggota Menunggak</span><strong>${unpaid}</strong><small>${state.currentWeek ? `Periode ${formatSchoolWeekLabel(state.currentWeek.cycle_start)}` : 'Belum ada minggu aktif'}</small></article>
    `;
  }

  function renderCashRules() {
    const list = $('#cashRulesList');
    if (!list || !state.appSettings) return;
    list.innerHTML = `
      <div class="setting-item"><span>Batas aman pembayaran</span><strong>${DAY_MAP[state.appSettings.safe_until_dow] || '-'}</strong></div>
      <div class="setting-item"><span>Denda berlapis</span><strong>${state.appSettings.late_day_count ? `+${state.appSettings.late_day_count} hari hitung aktif` : 'Aktif'}</strong></div>
      <div class="setting-item"><span>Notifikasi tunggakan</span><strong>Manual follow-up</strong></div>
      <div class="setting-item"><span>Mode validasi</span><strong>Password bendahara + edge function</strong></div>
    `;
  }

  function fillCashForm() {
    const memberSelect = $('#paymentMemberId');
    const cycleSelect = $('#paymentCycleSelect');
    const weekFilter = $('#cashWeekFilter');
    const orderedWeeks = getOrderedCashWeeks();
    if (memberSelect) {
      memberSelect.innerHTML = `<option value="">Pilih anggota</option>` + state.members.map((member) => `<option value="${member.id}">${escapeHtml(member.full_name)}</option>`).join('');
    }
    if (cycleSelect) {
      cycleSelect.innerHTML = `<option value="">Pilih minggu</option>` + orderedWeeks.map((week) => `<option value="${week.cycle_start}">${week.sequence_label} - ${formatDate(week.cycle_start)} - ${formatDate(addDaysISO(week.cycle_start, 4))}</option>`).join('');
      if (state.selectedCashCycleStart || state.currentWeek) cycleSelect.value = state.selectedCashCycleStart || state.currentWeek?.cycle_start || '';
    }
    if (weekFilter) {
      const currentVal = weekFilter.value;
      weekFilter.innerHTML = `<option value="">Pilih minggu</option>` + orderedWeeks.map((week) => `<option value="${week.cycle_start}">${week.sequence_label} - ${formatDate(week.cycle_start)} - ${formatDate(addDaysISO(week.cycle_start, 4))}</option>`).join('');
      weekFilter.value = currentVal || state.selectedCashCycleStart || state.currentWeek?.cycle_start || '';
      state.selectedCashCycleStart = weekFilter.value || state.selectedCashCycleStart || state.currentWeek?.cycle_start || '';
    }
    if (!orderedWeeks.some((week) => String(week.cycle_start) === String(state.selectedCashCycleStart || ''))) {
      state.selectedCashCycleStart = orderedWeeks[0]?.cycle_start || '';
    }
    renderCashWeekChips();
  }

  function renderCashWeekChips() {
    const wrap = $('#cashWeekChipList');
    if (!wrap) return;
    const orderedWeeks = getOrderedCashWeeks();
    const activeCycle = state.selectedCashCycleStart || $('#cashWeekFilter')?.value || state.currentWeek?.cycle_start || '';
    wrap.innerHTML = orderedWeeks.map((week) => `
      <button type="button" class="week-chip ${String(week.cycle_start) === String(activeCycle) ? 'active' : ''}" data-cash-week="${week.cycle_start}">
        <strong>${week.sequence_label}</strong>
        <span>${formatDate(week.cycle_start)} - ${formatDate(addDaysISO(week.cycle_start, 4))}</span>
      </button>
    `).join('');
    wrap.querySelectorAll('[data-cash-week]').forEach((button) => {
      button.addEventListener('click', async () => {
        const cycleStart = String(button.getAttribute('data-cash-week') || '');
        state.selectedCashCycleStart = cycleStart;
        const filter = $('#cashWeekFilter');
        const cycleSelect = $('#paymentCycleSelect');
        if (filter) filter.value = cycleStart;
        if (cycleSelect) cycleSelect.value = cycleStart;
        renderCashWeekChips();
        await renderCashStatusTable();
      });
    });
  }

  function bindCashActions() {
    if ($('#cashPaymentForm')?.dataset.bound === 'true') return;
    const form = $('#cashPaymentForm');
    const openBtn = $('#btnOpenPaymentModal');
    const filterBtn = $('#btnApplyCashFilter');
    if (!form) return;
    form.dataset.bound = 'true';

    openBtn?.addEventListener('click', () => {
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('#paymentMemberId')?.focus();
    });

    filterBtn?.addEventListener('click', async (event) => {
      event.preventDefault();
      state.selectedCashCycleStart = $('#cashWeekFilter')?.value || state.selectedCashCycleStart || '';
      renderCashWeekChips();
      await renderCashStatusTable();
      showToast('Filter diterapkan', 'Status kas mingguan sudah diperbarui.', 'success');
    });

    $('#cashWeekFilter')?.addEventListener('change', async () => {
      state.selectedCashCycleStart = $('#cashWeekFilter')?.value || state.selectedCashCycleStart || '';
      const cycleSelect = $('#paymentCycleSelect');
      if (cycleSelect && state.selectedCashCycleStart) cycleSelect.value = state.selectedCashCycleStart;
      renderCashWeekChips();
      await renderCashStatusTable();
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const memberId = Number($('#paymentMemberId')?.value || 0);
      const cycleStart = $('#paymentCycleSelect')?.value || '';
      const note = $('#paymentNote')?.value?.trim() || null;
      if (!memberId || !cycleStart) {
        showToast('Data belum lengkap', 'Pilih anggota dan minggu pembayaran dulu.', 'error');
        return;
      }
      const password = await promptForPassword();
      if (!password) return;
      const button = $('#btnSavePayment');
      setButtonLoading(button, true, 'Menyimpan...');
      try {
        const previewRow = buildCashDisplayRows(state.weeklyStatus, cycleStart).find((row) => Number(row.member_id) === memberId) || buildDefaultCashRow(findMember(memberId) || { id: memberId, full_name: '-' }, cycleStart);
        const { error } = await state.db.rpc(PAYMENT_RPC_NAME, {
          p_password: password,
          p_member_id: memberId,
          p_cycle_start: cycleStart,
          p_note: note,
        });
        if (error) throw error;
        const paidRow = derivePaidCashFields({ ...previewRow, note }, memberId, cycleStart);
        upsertManualCashPayment(paidRow);
        upsertCashPaidFact(normalizeCashFactRow(paidRow) || paidRow);
        form.reset();
        if (state.selectedCashCycleStart || state.currentWeek?.cycle_start) $('#paymentCycleSelect').value = state.selectedCashCycleStart || state.currentWeek?.cycle_start;
        await primeCoreData();
        await renderCashPage();
        if (state.currentPage === 'dashboard.html') await renderDashboardPage();
        showToast('Pembayaran berhasil', 'Data kas sudah masuk ke Supabase.', 'success');
      } catch (error) {
        console.error(error);
        showToast('Gagal simpan pembayaran', error.message || 'Cek function treasurer_mark_cash_payment dan password bendahara.', 'error');
      } finally {
        setButtonLoading(button, false);
      }
    });
  }

  function hasStaleUnpaidAmount(row) {
    return !Boolean(row?.is_paid) && (
      Number(row?.paid_base_amount || 0) > 0 ||
      Number(row?.paid_fine_amount || 0) > 0 ||
      Number(row?.paid_amount || 0) > 0
    );
  }

  async function resetUnpaidRowInDatabase(row, cycleStart) {
    const candidatePlans = [
      {
        table: 'payments',
        filters: { member_id: row.member_id, cycle_start: cycleStart },
        updates: { paid_base_amount: 0, paid_fine_amount: 0, paid_amount: 0, base_amount: 0, fine_amount: 0, amount: 0, total_amount: 0, status: 'unpaid' },
      },
      {
        table: 'cash_payments',
        filters: { member_id: row.member_id, cycle_start: cycleStart },
        updates: { paid_base_amount: 0, paid_fine_amount: 0, paid_amount: 0, base_amount: 0, fine_amount: 0, amount: 0, total_amount: 0, status: 'unpaid' },
      },
      {
        table: 'member_payments',
        filters: { member_id: row.member_id, cycle_start: cycleStart },
        updates: { paid_base_amount: 0, paid_fine_amount: 0, paid_amount: 0, base_amount: 0, fine_amount: 0, amount: 0, total_amount: 0, status: 'unpaid' },
      },
      {
        table: 'weekly_payments',
        filters: { member_id: row.member_id, cycle_start: cycleStart },
        updates: { paid_base_amount: 0, paid_fine_amount: 0, paid_amount: 0, base_amount: 0, fine_amount: 0, amount: 0, total_amount: 0, status: 'unpaid' },
      },
      {
        table: 'cash_status',
        filters: { member_id: row.member_id, cycle_start: cycleStart },
        updates: { paid_base_amount: 0, paid_fine_amount: 0, paid_amount: 0, total_amount: 0, is_paid: false, status: 'unpaid' },
      },
      {
        table: 'member_weekly_cash_status',
        filters: { member_id: row.member_id, cycle_start: cycleStart },
        updates: { paid_base_amount: 0, paid_fine_amount: 0, paid_amount: 0, total_amount: 0, is_paid: false, status: 'unpaid' },
      },
    ];

    for (const plan of candidatePlans) {
      try {
        let query = state.db.from(plan.table).update(plan.updates);
        Object.entries(plan.filters).forEach(([key, value]) => {
          query = query.eq(key, value);
        });
        const { data, error } = await query.select('member_id').limit(1);
        if (!error && Array.isArray(data) && data.length) return true;
      } catch (error) {
        console.debug(`Reset unpaid skip ${plan.table}`, error?.message || error);
      }
    }

    return false;
  }


  async function resetAllCashDataFromMonday() {
    const monday = getMondayIsoDate();
    const candidatePlans = [
      { table: 'payments', filters: [['cycle_start', 'gte', monday]], updates: { paid_base_amount: 0, paid_fine_amount: 0, paid_amount: 0, base_amount: 0, fine_amount: 0, amount: 0, total_amount: 0, status: 'unpaid' } },
      { table: 'cash_payments', filters: [['cycle_start', 'gte', monday]], updates: { paid_base_amount: 0, paid_fine_amount: 0, paid_amount: 0, base_amount: 0, fine_amount: 0, amount: 0, total_amount: 0, status: 'unpaid' } },
      { table: 'member_payments', filters: [['cycle_start', 'gte', monday]], updates: { paid_base_amount: 0, paid_fine_amount: 0, paid_amount: 0, base_amount: 0, fine_amount: 0, amount: 0, total_amount: 0, status: 'unpaid' } },
      { table: 'weekly_payments', filters: [['cycle_start', 'gte', monday]], updates: { paid_base_amount: 0, paid_fine_amount: 0, paid_amount: 0, base_amount: 0, fine_amount: 0, amount: 0, total_amount: 0, status: 'unpaid' } },
      { table: 'cash_status', filters: [['cycle_start', 'gte', monday]], updates: { paid_base_amount: 0, paid_fine_amount: 0, paid_amount: 0, total_amount: 0, is_paid: false, status: 'unpaid' } },
      { table: 'member_weekly_cash_status', filters: [['cycle_start', 'gte', monday]], updates: { paid_base_amount: 0, paid_fine_amount: 0, paid_amount: 0, total_amount: 0, is_paid: false, status: 'unpaid' } },
      { table: 'members', filters: [], updates: { saldo: 0, balance: 0, cash_balance: 0 } },
    ];

    let touched = 0;
    for (const plan of candidatePlans) {
      try {
        let query = state.db.from(plan.table).update(plan.updates);
        for (const [key, op, value] of plan.filters) {
          if (op === 'gte') query = query.gte(key, value);
          if (op === 'eq') query = query.eq(key, value);
        }
        const { data, error } = await query.select('*').limit(1);
        if (!error) touched += 1;
      } catch (error) {
        console.debug(`Reset all skip ${plan.table}`, error?.message || error);
      }
    }

    if (!touched) throw new Error('Nama tabel saldo atau pembayaran belum cocok dengan schema Supabase.');
    return monday;
  }

  async function renderCashStatusTable() {
    const tbody = $('#cashStatusTable');
    if (!tbody) return;
    const cycleStart = state.selectedCashCycleStart || $('#cashWeekFilter')?.value || state.currentWeek?.cycle_start || '';
    state.selectedCashCycleStart = cycleStart || state.selectedCashCycleStart || '';
    const statusFilter = $('#cashStatusFilter')?.value || 'all';
    const weekLabel = $('#cashWeekLabel');
    if (!cycleStart) {
      tbody.innerHTML = `<tr><td colspan="7">Belum ada periode mingguan.</td></tr>`;
      if (weekLabel) weekLabel.textContent = 'Belum ada minggu aktif';
      return;
    }
    if (weekLabel) weekLabel.textContent = formatSchoolWeekLabel(cycleStart);
    renderCashWeekChips();

    const { data, error } = await state.db.from('v_cash_member_weekly_status').select('*').eq('cycle_start', cycleStart).order('member_id', { ascending: true });
    if (error) {
      console.error(error);
      tbody.innerHTML = `<tr><td colspan="7">Gagal memuat status kas.</td></tr>`;
      return;
    }
    let rows = buildCashDisplayRows(data || [], cycleStart);
    if (String(cycleStart) === String(state.currentWeek?.cycle_start || '')) {
      state.weeklyStatus = rows.slice();
    }
    if (statusFilter === 'paid') rows = rows.filter((row) => row.is_paid);
    if (statusFilter === 'unpaid') rows = rows.filter((row) => !row.is_paid);
    tbody.innerHTML = rows.length ? rows.map((row) => {
      const isPaid = Boolean(row.is_paid);
      const hasFine = Number(row.current_fine_amount || 0) > 0;
      const status = isPaid
        ? `<span class="pill success">Lunas</span>`
        : hasFine
          ? `<div class="cash-status-stack"><span class="pill danger">Belum bayar</span><small class="cash-status-note">Denda aktif</small></div>`
          : `<span class="pill danger">Belum bayar</span>`;
      const actionType = isPaid ? 'none' : 'mark-paid';
      const actionLabel = isPaid ? '-' : 'Tandai bayar';
      const baseView = isPaid ? Number(row.paid_base_amount || 0) : Number(row.base_amount || 0);
      const fineView = isPaid ? Number(row.paid_fine_amount || 0) : Number(row.current_fine_amount || 0);
      const totalView = isPaid ? Number(row.paid_amount || 0) : Number(row.outstanding_total_today || 0);
      return `
        <tr>
          <td>${escapeHtml(row.full_name || '-')}</td>
          <td>${escapeHtml(extractDivision(findMember(row.member_id)) || '-')}</td>
          <td>${status}</td>
          <td>${formatMoney(baseView)}</td>
          <td>${formatMoney(fineView)}</td>
          <td>${formatMoney(totalView)}</td>
          <td>${isPaid ? '-' : `<a href="#" class="text-link" data-action="${actionType}" data-member-id="${row.member_id}" data-cycle-start="${cycleStart}">${actionLabel}</a>`}</td>
        </tr>
      `;
    }).join('') : `<tr><td colspan="7">Tidak ada data untuk filter ini.</td></tr>`;

    tbody.querySelectorAll('[data-action="mark-paid"]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        $('#paymentMemberId').value = link.dataset.memberId;
        $('#paymentCycleSelect').value = link.dataset.cycleStart;
        $('#paymentNote').focus();
        $('#cashPaymentForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    tbody.querySelectorAll('[data-action="reset-unpaid-db"]').forEach((link) => {
      link.addEventListener('click', async (event) => {
        event.preventDefault();
        const memberId = Number(link.dataset.memberId || 0);
        const selectedRow = rows.find((row) => Number(row.member_id) === memberId);
        if (!selectedRow) {
          showToast('Data tidak ditemukan', 'Baris kas yang mau di-reset tidak ketemu.', 'error');
          return;
        }
        link.style.pointerEvents = 'none';
        link.textContent = 'Reset...';
        const success = await resetUnpaidRowInDatabase(selectedRow, link.dataset.cycleStart || cycleStart);
        if (!success) {
          link.style.pointerEvents = '';
          link.textContent = 'Reset DB';
          showToast('Reset database gagal', 'Nama tabel pembayaran di database belum cocok dengan project ini.', 'error');
          return;
        }
        await primeCoreData();
        await renderCashPage();
        showToast('Reset database berhasil', 'Nominal anggota yang belum bayar sudah direset ke 0 di database.', 'success');
      });
    });
  }

  async function renderMembersPage(isRealtime = false) {
    bindMemberActions();
    renderMemberCardsAndTable();
    if (isRealtime) showToast('Data anggota diperbarui', 'Perubahan anggota terbaru sudah sinkron.', 'success');
  }

  function populateMemberFilters() {
    return;
  }

  function bindMemberActions() {
    const memberGrid = $('#memberGrid');
    if (!memberGrid || memberGrid.dataset.bound === 'true') return;
    memberGrid.dataset.bound = 'true';
    $('#memberSearchInput')?.addEventListener('input', renderMemberCardsAndTable);
    $('#memberActiveFilter')?.addEventListener('change', renderMemberCardsAndTable);
    $('#memberSortFilter')?.addEventListener('change', renderMemberCardsAndTable);
  }

  function renderMemberCardsAndTable() {
    const grid = $('#memberGrid');
    const tbody = $('#memberTableBody');
    if (!grid || !tbody) return;

    const query = ($('#memberSearchInput')?.value || '').trim().toLowerCase();
    const activeFilter = $('#memberActiveFilter')?.value || 'active';
    const sortFilter = $('#memberSortFilter')?.value || 'az';

    const byMember = new Map();
    state.weeklyStatus.forEach((row) => byMember.set(row.member_id, row));
    const faceCount = groupCount(state.faceProfiles, 'member_id');

    let rows = [...state.members];
    rows = rows.filter((member) => {
      const hay = `${member.full_name || ''} ${extractRole(member) || ''}`.toLowerCase();
      const matchesQuery = !query || hay.includes(query);
      const isActive = member.is_active !== false;
      const matchesActive = activeFilter === 'all' || (activeFilter === 'active' ? isActive : !isActive);
      return matchesQuery && matchesActive;
    });
    rows.sort((a, b) => sortFilter === 'za' ? (b.full_name || '').localeCompare(a.full_name || '') : (a.full_name || '').localeCompare(b.full_name || ''));

    grid.innerHTML = rows.length ? rows.map((member) => {
      const status = byMember.get(member.id);
      const cashLabel = status ? (status.is_paid ? 'Lunas' : Number(status.current_fine_amount || 0) > 0 ? 'Denda aktif' : 'Belum bayar') : 'Belum ada minggu aktif';
      const faceTotal = Number(faceCount.get(member.id) || 0);
      const faceLabel = faceTotal ? `${faceTotal} wajah tersimpan` : 'Belum terdaftar';
      const pillClass = member.is_active === false ? 'danger' : status?.is_paid ? 'success' : 'warning';
      const pillText = member.is_active === false ? 'Nonaktif' : status?.is_paid ? 'Aktif' : 'Perlu follow-up';
      return `
        <article class="member-card compact-member-card">
          <div class="member-card-top">
            <div class="avatar-circle">${escapeHtml(initials(member.full_name))}</div>
            <div class="member-identity">
              <h3>${escapeHtml(member.full_name || '-')}</h3>
              <p>${escapeHtml(extractRole(member) || 'Anggota')}</p>
            </div>
            <span class="pill ${pillClass}">${pillText}</span>
          </div>
          <div class="member-stat-row">
            <div class="member-stat"><span>Status kas</span><strong>${cashLabel}</strong></div>
            <div class="member-stat"><span>Profil wajah</span><strong>${faceLabel}</strong></div>
          </div>
          <div class="member-actions">
            <a href="#" data-action="member-view" data-member-id="${member.id}">Detail</a>
            <a href="#" data-action="member-face" data-member-id="${member.id}">Daftarkan wajah</a>
          </div>
        </article>
      `;
    }).join('') : `<div class="empty-state">Tidak ada anggota yang cocok.</div>`;

    tbody.innerHTML = rows.length ? rows.map((member) => {
      const status = byMember.get(member.id);
      const cashStatus = status ? (status.is_paid ? `<span class="pill success">Lunas</span>` : Number(status.current_fine_amount || 0) > 0 ? `<span class="pill warning">Denda aktif</span>` : `<span class="pill danger">Belum bayar</span>`) : `<span class="pill warning">Belum ada data</span>`;
      const faceLabel = faceCount.get(member.id) ? `Terdaftar (${faceCount.get(member.id)})` : 'Belum ada';
      return `
        <tr>
          <td>${escapeHtml(member.full_name || '-')}</td>
          <td>${escapeHtml(extractRole(member) || '-')}</td>
          <td>${cashStatus}</td>
          <td>${faceLabel}</td>
          <td><a href="#" class="text-link" data-action="member-view" data-member-id="${member.id}">Detail</a></td>
        </tr>
      `;
    }).join('') : `<tr><td colspan="5">Tidak ada anggota yang cocok.</td></tr>`;

    $$('[data-action="member-view"]').forEach((link) => link.addEventListener('click', (event) => {
      event.preventDefault();
      openMemberDetailModal(Number(link.dataset.memberId));
    }));
    $$('[data-action="member-face"]').forEach((link) => link.addEventListener('click', (event) => {
      event.preventDefault();
      window.location.href = `./rapat.html?member=${link.dataset.memberId}`;
    }));
  }

  function openMemberModal() {
    showToast('Data anggota dikunci', 'Jumlah anggota tetap 15 orang, jadi fitur tambah anggota dimatikan.', 'warning');
  }

  function openMemberDetailModal(memberId) {
    const member = findMember(memberId);
    if (!member) return;
    const weekly = state.weeklyStatus.find((row) => row.member_id === memberId);
    const faceTotal = state.faceProfiles.filter((row) => row.member_id === memberId).length;
    const content = document.createElement('div');
    content.innerHTML = `
      <div class="detail-list compact-profile-list">
        <div><span>Nama</span><strong>${escapeHtml(member.full_name || '-')}</strong></div>
        <div><span>Jabatan</span><strong>${escapeHtml(extractRole(member) || '-')}</strong></div>
        <div><span>Status aktif</span><strong>${member.is_active === false ? 'Nonaktif' : 'Aktif'}</strong></div>
        <div><span>Status kas</span><strong>${weekly ? (weekly.is_paid ? 'Lunas' : 'Belum lunas') : 'Belum ada data'}</strong></div>
        <div><span>Profil wajah</span><strong>${faceTotal} file</strong></div>
      </div>
    `;
    openModal('Profil anggota', 'Ringkasan inti anggota MPK.', content);
  }

  async function deleteMeetingSession(meetingId, password) {
    const meeting = state.meetings.find((item) => Number(item.id) === Number(meetingId));
    if (!meeting) throw new Error('Sesi rapat tidak ditemukan.');
    if (!String(password || '').trim()) throw new Error('Password hapus sesi wajib diisi.');

    let rpcError = null;
    try {
      const rpc = await state.db.rpc('delete_meeting_session', {
        p_meeting_id: meetingId,
        p_password: String(password || '').trim(),
      });
      if (rpc.error) rpcError = rpc.error;
      if (!rpcError) {
        await primeCoreData();
        await renderMeetingsPage();
        return;
      }
    } catch (error) {
      rpcError = error;
    }

    const message = String(rpcError?.message || '').toLowerCase();
    const missingRpc = message.includes('could not find the function') || message.includes('schema cache') || message.includes('delete_meeting_session');
    if (missingRpc) {
      throw new Error('Function delete_meeting_session terbaru belum diimpor. Jalankan file sql/delete_meeting_session.sql dulu.');
    }
    throw rpcError;
  }

  async function renderMeetingsPage(isRealtime = false) {
    bindMeetingActions();
    renderMeetingTimeline();
    if (isRealtime) showToast('Rapat diperbarui', 'Perubahan sesi rapat terbaru sudah muncul.', 'success');
  }

  async function toggleMeetingOpenState(meetingId, nextOpenState) {
    const { error } = await state.db.from('meetings').update({ is_open: nextOpenState }).eq('id', meetingId);
    if (error) throw error;
    await primeCoreData();
    await renderMeetingsPage();
  }

  function bindMeetingActions() {
    const timelineGrid = $('#meetingTimelineGrid');
    if (!timelineGrid) return;
    if (timelineGrid.dataset.bound === 'true') return;
    timelineGrid.dataset.bound = 'true';
    $('#btnOpenMeetingModal')?.addEventListener('click', openMeetingModal);
  }

  function renderMeetingTimeline() {
    const grid = $('#meetingTimelineGrid');
    if (!grid) return;
    const attendanceByMeeting = groupCount(state.attendanceRecent.filter((row) => row.matched), 'meeting_id');
    grid.innerHTML = state.meetings.length ? state.meetings.slice(0, 10).map((meeting, index) => {
      const present = attendanceByMeeting.get(meeting.id) || 0;
      const badge = meeting.is_open ? (index === 0 ? 'primary' : 'warning') : 'success';
      const label = meeting.is_open ? (index === 0 ? 'Aktif' : 'Terbuka') : 'Selesai';
      return `
        <article class="timeline-card ${index === 0 ? 'active' : ''}" data-meeting-id="${meeting.id}">
          <div class="timeline-card-head">
            <span class="pill ${badge}">${label}</span>
            <div class="timeline-card-actions"><button type="button" class="timeline-card-toggle" data-toggle-meeting="${meeting.id}" data-next-open="${meeting.is_open ? 'false' : 'true'}">${meeting.is_open ? 'Tutup sesi' : 'Buka lagi'}</button><button type="button" class="timeline-card-delete" data-delete-meeting="${meeting.id}">Hapus</button></div>
          </div>
          <h3>${escapeHtml(meeting.title || '-')}</h3>
          <p>${formatDate(meeting.meeting_date)}${meeting.note ? ` - ${escapeHtml(trimText(meeting.note, 30))}` : ''}</p>
          <small>${present} scan hadir tercatat${meeting.is_open ? ' - sesi masih dibuka' : ' - sesi sudah ditutup'}</small>
        </article>
      `;
    }).join('') : `<div class="empty-state"><strong>Belum ada sesi rapat.</strong><span>Mulai buat sesi rapat baru dari halaman ini.</span><div style="margin-top:14px;display:flex;justify-content:center;"><button type="button" class="btn btn-primary" id="btnOpenMeetingInline">Buat sesi rapat</button></div></div>`;

    const initialMeeting = state.meetings[0] || null;
    if (initialMeeting) {
      fillMeetingDetail(initialMeeting.id);
    } else {
      const title = $('#meetingDetailTitle');
      const detail = $('#meetingDetailList');
      const activity = $('#meetingAttendanceList');
      const activeMeetingTitle = $('#activeMeetingTitle');
      const weekLabel = $('#meetingWeekLabel');
      if (title) title.textContent = 'Belum ada sesi dipilih';
      if (detail) detail.innerHTML = '<div><span>Status</span><strong>Belum ada sesi rapat</strong></div>';
      if (activity) activity.innerHTML = '<li><strong>Belum ada data kehadiran</strong><span>Buat sesi rapat dulu untuk mulai scan.</span></li>';
      if (activeMeetingTitle) activeMeetingTitle.textContent = 'Belum ada sesi rapat';
      if (weekLabel) weekLabel.textContent = 'Pilih sesi rapat';
    }
    $('#btnOpenMeetingInline')?.addEventListener('click', openMeetingModal);
    $$('.timeline-card[data-meeting-id]').forEach((card) => {
      card.addEventListener('click', () => {
        $$('.timeline-card[data-meeting-id]').forEach((item) => item.classList.remove('active'));
        card.classList.add('active');
        fillMeetingDetail(Number(card.dataset.meetingId));
      });
    });
    $$('[data-toggle-meeting]').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const meetingId = Number(button.dataset.toggleMeeting || 0);
        const nextOpenState = button.dataset.nextOpen === 'true';
        setButtonLoading(button, true, nextOpenState ? 'Membuka...' : 'Menutup...');
        try {
          await toggleMeetingOpenState(meetingId, nextOpenState);
          showToast('Status rapat diperbarui', nextOpenState ? 'Sesi rapat dibuka lagi.' : 'Sesi rapat berhasil ditutup.', 'success');
        } catch (error) {
          console.error(error);
          showToast('Gagal ubah status rapat', error.message || 'Periksa izin update tabel meetings.', 'error');
          setButtonLoading(button, false);
        }
      });
    });
    $$('[data-delete-meeting]').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const meetingId = Number(button.dataset.deleteMeeting || 0);
        const meeting = state.meetings.find((item) => Number(item.id) === meetingId);
        if (!meeting) return;
        const deletePassword = await confirmDeleteMeetingDialog(meeting);
        if (!deletePassword) return;
        setButtonLoading(button, true, 'Menghapus...');
        showProcessingOverlay('Menghapus sesi rapat...');
        try {
          await deleteMeetingSession(meetingId, deletePassword);
          showToast('Sesi rapat dihapus', 'Sesi rapat dan data kehadiran terkait sudah dihapus.', 'success');
        } catch (error) {
          console.error(error);
          showToast('Gagal hapus sesi', error.message || 'Impor file SQL helper delete_meeting_session bila diperlukan.', 'error');
          setButtonLoading(button, false);
        } finally {
          hideProcessingOverlay();
        }
      });
    });
  }

  function fillMeetingDetail(meetingId) {
    const meeting = state.meetings.find((item) => item.id === meetingId);
    if (!meeting) return;
    const title = $('#meetingDetailTitle');
    const detail = $('#meetingDetailList');
    const activity = $('#meetingAttendanceList');
    if (title) title.textContent = meeting.title || '-';
    const scans = state.attendanceRecent.filter((row) => row.meeting_id === meetingId && row.matched);
    const unmatched = state.attendanceRecent.filter((row) => row.meeting_id === meetingId && !row.matched).length;
    const uniqueScans = [];
    const seenMembers = new Set();
    scans.forEach((row) => {
      const key = row.member_id || `unknown-${row.id}`;
      if (seenMembers.has(key)) return;
      seenMembers.add(key);
      uniqueScans.push(row);
    });
    const targetMembers = state.members.filter((member) => member.is_active !== false).length;
    if (detail) {
      detail.innerHTML = `
        <div><span>Tanggal</span><strong>${formatDate(meeting.meeting_date)}</strong></div>
        <div><span>Status</span><strong>${meeting.is_open ? 'Berlangsung / terbuka' : 'Ditutup'}</strong></div>
        <div><span>Sudah scan</span><strong>${uniqueScans.length} anggota</strong></div>
        <div><span>Belum scan</span><strong>${Math.max(targetMembers - uniqueScans.length, 0)} anggota</strong></div>
        <div class="meeting-detail-actions"><button class="btn btn-ghost" type="button" id="btnToggleMeetingState">${meeting.is_open ? 'Tutup sesi rapat' : 'Buka sesi rapat'}</button><button class="btn btn-danger-soft" type="button" id="btnDeleteMeetingState">Hapus sesi</button></div>
      `;
      $('#btnToggleMeetingState')?.addEventListener('click', async () => {
        const button = $('#btnToggleMeetingState');
        setButtonLoading(button, true, meeting.is_open ? 'Menutup...' : 'Membuka...');
        try {
          await toggleMeetingOpenState(meeting.id, !meeting.is_open);
          showToast('Status rapat diperbarui', !meeting.is_open ? 'Sesi rapat dibuka lagi.' : 'Sesi rapat berhasil ditutup.', 'success');
        } catch (error) {
          console.error(error);
          showToast('Gagal ubah status rapat', error.message || 'Periksa izin update tabel meetings.', 'error');
          setButtonLoading(button, false);
        }
      });
      $('#btnDeleteMeetingState')?.addEventListener('click', async () => {
        const button = $('#btnDeleteMeetingState');
        const deletePassword = await confirmDeleteMeetingDialog(meeting);
        if (!deletePassword) return;
        setButtonLoading(button, true, 'Menghapus...');
        showProcessingOverlay('Menghapus sesi rapat...');
        try {
          await deleteMeetingSession(meeting.id, deletePassword);
          showToast('Sesi rapat dihapus', 'Sesi rapat dan data kehadiran terkait sudah dihapus.', 'success');
        } catch (error) {
          console.error(error);
          showToast('Gagal hapus sesi', error.message || 'Impor file SQL helper delete_meeting_session bila diperlukan.', 'error');
          setButtonLoading(button, false);
        } finally {
          hideProcessingOverlay();
        }
      });
    }
    if (activity) {
      activity.innerHTML = uniqueScans.length ? uniqueScans.map((row, index) => `
        <li><strong>${index + 1}. ${escapeHtml(row.members?.full_name || 'Wajah dikenali tanpa nama')}</strong><span>${Math.round(Number(row.confidence || 0))}% cocok - ${formatDateTime(row.scanned_at)}</span></li>
      `).join('') : `<li><strong>Belum ada anggota yang scan</strong><span>Jalankan absensi wajah untuk sesi ini dulu.</span></li>`;
      activity.insertAdjacentHTML('beforeend', `
        <li><strong>${unmatched} log belum cocok</strong><span>Perlu validasi manual kalau ada scan tanpa match.</span></li>
      `);
    }
    const meetingSelect = $('#attendanceMeetingId');
    if (meetingSelect) {
      meetingSelect.value = String(meeting.id);
      syncAttendanceMemberSelection();
      updateAttendanceAutoTargetLabel();
      updateAttendanceSidebar();
      renderAttendanceRosterTable();
      updateScanLogList();
      const weekLabel = $('#meetingWeekLabel');
      if (weekLabel) weekLabel.textContent = `${formatDate(meeting.meeting_date)} - ${meeting.is_open ? 'Sesi aktif' : 'Sesi ditutup'}`;
    }
  }

  function openMeetingModal() {
    const form = document.createElement('form');
    form.className = 'form-grid meeting-create-form';
    form.innerHTML = `
      <label><span>Judul rapat</span><input name="title" required placeholder="Rapat evaluasi mingguan" /></label>
      <label><span>Tanggal</span><input name="meeting_date" type="date" required value="${getTodayISODate()}" /></label>
      <label><span>Status sesi</span><select name="is_open"><option value="true">Dibuka</option><option value="false">Ditutup</option></select></label>
      <label class="full"><span>Catatan</span><textarea name="note" rows="4" placeholder="Agenda atau keterangan"></textarea></label>
      <div class="form-actions full"><button class="btn btn-ghost" type="button" data-close-modal>Batal</button><button class="btn btn-primary" type="submit">Simpan Sesi</button></div>
    `;
    const modal = openModal('Buat sesi rapat baru', 'Atur judul, tanggal, dan status sesi. Data sesi akan langsung masuk ke tabel meetings.', form);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = event.submitter;
      setButtonLoading(submit, true, 'Menyimpan...');
      showProcessingOverlay('Menyimpan sesi rapat...');
      const fd = new FormData(form);
      try {
        const { error } = await state.db.from('meetings').insert({
          title: String(fd.get('title') || '').trim(),
          meeting_date: fd.get('meeting_date'),
          note: String(fd.get('note') || '').trim() || null,
          is_open: String(fd.get('is_open')) === 'true',
        });
        if (error) throw error;
        closeModal(modal);
        await primeCoreData();
        renderMeetingsPage();
        showToast('Sesi rapat dibuat', 'Rapat baru sudah tersimpan ke database.', 'success');
      } catch (error) {
        console.error(error);
        showToast('Gagal membuat sesi', error.message || 'Periksa izin insert ke tabel meetings.', 'error');
      } finally {
        hideProcessingOverlay();
        setButtonLoading(submit, false);
      }
    });
  }


  function getDeletePasswordCandidates() {
    const settings = state.appSettings || {};
    const config = window.APP_CONFIG || {};
    return [
      settings.delete_password,
      settings.admin_password,
      settings.treasurer_password,
      settings.password_bendahara,
      settings.bendahara_password,
      config.DELETE_PASSWORD,
      config.ADMIN_PASSWORD,
      config.TREASURER_PASSWORD,
    ].map((value) => String(value || '').trim()).filter(Boolean);
  }

  async function confirmDeleteMeetingDialog(meeting) {
    const scans = state.attendanceRecent.filter((row) => Number(row.meeting_id) === Number(meeting?.id));
    return new Promise((resolve) => {
      const content = document.createElement('div');
      content.innerHTML = `
        <div class="modal-danger-summary">
          <strong>${escapeHtml(meeting?.title || 'Sesi rapat')}</strong>
          <span>Tanggal ${formatDate(meeting?.meeting_date)} - ${scans.length} data scan terkait akan ikut terhapus.</span>
        </div>
        <div class="form-grid">
          <label class="full">
            <span>Password konfirmasi</span>
            <input id="meetingDeletePasswordInput" type="password" placeholder="Masukkan password hapus sesi" autocomplete="current-password" />
            <small class="modal-helper-note">Password ini akan dikirim ke function delete_meeting_session terbaru di Supabase.</small>
            <small class="modal-inline-error" id="meetingDeletePasswordError">Password wajib diisi.</small>
          </label>
          <div class="form-actions full">
            <button type="button" class="btn btn-ghost" data-close-modal>Batal</button>
            <button type="button" class="btn btn-danger-soft" id="confirmDeleteMeetingBtn">Hapus permanen</button>
          </div>
        </div>
      `;
      const modal = openModal('Hapus sesi rapat', 'Periksa lagi sebelum menghapus. Tindakan ini tidak bisa dibatalkan.', content, false, 'app-modal--danger');
      const input = $('#meetingDeletePasswordInput', modal);
      const error = $('#meetingDeletePasswordError', modal);
      const confirmBtn = $('#confirmDeleteMeetingBtn', modal);
      const finish = (value) => {
        modal.dataset.modalResolved = 'true';
        closeModal(modal);
        resolve(value || '');
      };
      const shakeError = (message) => {
        if (error) {
          error.textContent = message;
          error.classList.add('is-show');
        }
        input?.focus();
        input?.select?.();
      };
      const validate = () => {
        const value = String(input?.value || '').trim();
        if (!value) {
          shakeError('Password wajib diisi dulu.');
          return;
        }
        finish(value);
      };
      setTimeout(() => input?.focus(), 50);
      confirmBtn?.addEventListener('click', validate);
      input?.addEventListener('input', () => error?.classList.remove('is-show'));
      input?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          validate();
        }
      });
      modal.addEventListener('close-modal-intent', () => {
        if (modal.dataset.modalResolved === 'true') return;
        resolve('');
      }, { once: true });
    });
  }

  async function renderAttendancePage(isRealtime = false) {
    hydrateAttendancePage();
    bindAttendanceActions();
    syncAttendanceMemberSelection();
    updateAttendanceAutoTargetLabel();
    updateAttendanceSidebar();
    renderAttendanceRosterTable();
    updateScanLogList();
    applyAttendanceQueryPreset();
    if (isRealtime) showToast('Absensi rapat diperbarui', 'Scan terbaru dan status peserta sudah sinkron.', 'success');
  }

  function hydrateAttendancePage() {
    const memberSelect = $('#faceMemberId');
    const meetingSelect = $('#attendanceMeetingId');
    if (memberSelect) {
      memberSelect.innerHTML = `<option value="">Pilih anggota</option>`;
    }
    if (meetingSelect) {
      meetingSelect.innerHTML = `<option value="">Pilih sesi rapat</option>` + state.meetings.map((meeting) => `<option value="${meeting.id}">${escapeHtml(meeting.title)} - ${formatDate(meeting.meeting_date)}</option>`).join('');
      const openMeeting = state.meetings.find((meeting) => meeting.is_open) || state.meetings[0] || null;
      if (openMeeting) meetingSelect.value = String(openMeeting.id);
    }
    const emptyState = $('.camera-empty-state', $('#cameraStage')) || document.createElement('div');
    if (!emptyState.classList.contains('camera-empty-state')) {
      emptyState.className = 'camera-empty-state';
      $('#cameraStage')?.appendChild(emptyState);
    }
    emptyState.innerHTML = `<div><strong>Kamera siap diaktifkan</strong><span>Arahkan wajah anggota ke area frame lalu tekan scan untuk mencatat hadir rapat.</span></div>`;
    if (!$('.camera-status-chip', $('#cameraStage'))) {
      const chip = document.createElement('div');
      chip.className = 'camera-status-chip';
      chip.id = 'cameraStatusChip';
      chip.textContent = 'Kamera belum aktif';
      $('#cameraStage')?.appendChild(chip);
    }
    $('#btnTakeAttendance') && ($('#btnTakeAttendance').textContent = 'Scan Kehadiran');
    $('#btnStartCameraHeader')?.remove();
    syncAttendanceMemberSelection();
    updateAttendanceAutoTargetLabel();
    updateAttendanceSidebar();
    renderAttendanceRosterTable();
    updateScanLogList();
  }

  function bindAttendanceActions() {
    const panel = $('#cameraStage');
    if (!panel || panel.dataset.bound === 'true') return;
    panel.dataset.bound = 'true';
    $('#btnToggleAttendanceCamera')?.addEventListener('click', async () => {
      if (state.stream) {
        stopCamera();
        updateAttendanceCameraToggleLabel();
      } else {
        await startCamera();
        updateAttendanceCameraToggleLabel();
      }
    });
    $('#btnTakeAttendance')?.addEventListener('click', () => processFaceMode('auto'));
    updateAttendanceCameraToggleLabel();
    $('#attendanceMeetingId')?.addEventListener('change', () => { syncAttendanceMemberSelection(); updateAttendanceAutoTargetLabel(); updateAttendanceSidebar(); renderAttendanceRosterTable(); updateScanLogList(); });
  }

  function applyAttendanceQueryPreset() {
    const params = new URLSearchParams(window.location.search);
    const member = params.get('member');
    if (member && $('#faceMemberId')) $('#faceMemberId').value = member;
  }

  function toggleAttendanceMeetingField() {
    const label = $('#attendanceMeetingLabel');
    if (label) label.style.display = '';
  }

  function syncAttendanceMemberSelection() {
    const memberSelect = $('#faceMemberId');
    if (!memberSelect) return;
    const selectedMeetingId = Number($('#attendanceMeetingId')?.value || state.meetings.find((m) => m.is_open)?.id || state.meetings[0]?.id || 0);
    const scansByMember = new Map();
    state.attendanceRecent.filter((row) => row.meeting_id === selectedMeetingId && row.matched).forEach((row) => {
      if (!scansByMember.has(row.member_id)) scansByMember.set(row.member_id, row);
    });
    const rows = state.members.filter((m) => m.is_active !== false).map((member) => ({
      member,
      scanned: scansByMember.has(member.id),
    })).sort((a, b) => Number(a.scanned) - Number(b.scanned) || String(a.member.full_name).localeCompare(String(b.member.full_name)));
    memberSelect.innerHTML = `<option value="">Pilih anggota</option>` + rows.map((row) => `<option value="${row.member.id}">${escapeHtml(row.member.full_name)}${row.scanned ? ' — sudah scan' : ''}</option>`).join('');
    const currentValue = Number(memberSelect.value || 0);
    const currentStillValid = rows.find((row) => row.member.id === currentValue && !row.scanned);
    const firstPending = rows.find((row) => !row.scanned) || rows[0] || null;
    const target = currentStillValid || firstPending;
    memberSelect.value = target ? String(target.member.id) : '';
  }

  function updateAttendanceAutoTargetLabel() { return; }

  function updateAttendanceSidebar() {
    const meetingId = Number($('#attendanceMeetingId')?.value || state.meetings[0]?.id || 0);
    const meeting = state.meetings.find((item) => item.id === meetingId) || state.meetings[0] || null;
    const title = $('#activeMeetingTitle');
    if (!meeting) {
      if (title) title.textContent = 'Belum ada sesi rapat';
      $('#attendanceTargetCount') && ($('#attendanceTargetCount').textContent = '0');
      $('#attendanceDoneCount') && ($('#attendanceDoneCount').textContent = '0');
      $('#attendancePendingCount') && ($('#attendancePendingCount').textContent = '0');
      return;
    }
    const scans = state.attendanceRecent.filter((row) => row.meeting_id === meeting.id && row.matched).length;
    const target = state.members.filter((m) => m.is_active !== false).length;
    const pending = Math.max(target - scans, 0);
    if (title) title.textContent = `${meeting.title} - ${formatDate(meeting.meeting_date)}`;
    $('#attendanceTargetCount') && ($('#attendanceTargetCount').textContent = String(target));
    $('#attendanceDoneCount') && ($('#attendanceDoneCount').textContent = String(scans));
    $('#attendancePendingCount') && ($('#attendancePendingCount').textContent = String(pending));
  }

  function updateAttendanceCameraToggleLabel() {
    const btn = $('#btnToggleAttendanceCamera');
    if (!btn) return;
    btn.textContent = state.stream ? 'Matikan Kamera' : 'Nyalakan Kamera';
  }

  function renderAttendanceRosterTable() {
    const body = $('#attendanceRosterTable');
    if (!body) return;
    const selectedMeetingId = Number($('#attendanceMeetingId')?.value || state.meetings[0]?.id || 0);
    const scansByMember = new Map();
    state.attendanceRecent.filter((row) => row.meeting_id === selectedMeetingId && row.matched).forEach((row) => {
      if (!scansByMember.has(row.member_id)) scansByMember.set(row.member_id, row);
    });
    const rows = state.members.filter((m) => m.is_active !== false).map((member) => {
      const scan = scansByMember.get(member.id);
      return {
        member,
        scanned: !!scan,
        scanned_at: scan?.scanned_at || null,
      };
    }).sort((a,b) => Number(a.scanned) - Number(b.scanned) || String(a.member.full_name).localeCompare(String(b.member.full_name)));
    body.innerHTML = rows.length ? rows.map((row) => `
      <tr>
        <td>${escapeHtml(row.member.full_name || '-')}</td>
        <td>${row.scanned ? '<span class="pill success">Sudah scan</span>' : '<span class="pill danger">Belum hadir</span>'}</td>
        <td>${renderDateTimeCell(row.scanned_at)}</td>
      </tr>
    `).join('') : `<tr><td colspan="3">Belum ada anggota aktif.</td></tr>`;
    syncAttendanceMemberSelection();
    updateAttendanceAutoTargetLabel();
  }

  function updateScanLogList() {
    const list = $('#scanLogList');
    if (!list) return;
    const selectedMeetingId = Number($('#attendanceMeetingId')?.value || state.meetings[0]?.id || 0);
    const rows = selectedMeetingId ? state.attendanceRecent.filter((row) => row.meeting_id === selectedMeetingId) : state.attendanceRecent;
    list.innerHTML = rows.length ? rows.slice(0, 12).map((row) => `
      <li><strong>${escapeHtml(row.members?.full_name || 'Wajah belum dikenali')}</strong><span>${row.matched ? `Confidence ${Math.round(Number(row.confidence || 0))}%` : 'Belum cocok'} - ${formatDateTime(row.scanned_at)}</span></li>
    `).join('') : `<li><strong>Belum ada log scan</strong><span>Jalankan kamera dan simpan absensi dulu.</span></li>`;
  }

  function getCameraRefs() {
    const stage = $('#cameraStage');
    return {
      stage,
      video: $('#cameraVideo'),
      canvas: $('#cameraCanvas'),
      empty: $('.camera-empty-state', stage),
      chip: $('#cameraStatusChip'),
    };
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      showToast('Kamera tidak didukung', 'Browser ini belum mendukung akses kamera.', 'error');
      return;
    }

    const { stage, video, empty, chip } = getCameraRefs();
    if (!video) {
      showToast('Elemen kamera tidak ditemukan', 'UI kamera di halaman ini belum termuat dengan benar.', 'error');
      return;
    }

    try {
      stopCamera();
      video.setAttribute('playsinline', 'true');
      video.muted = true;
      video.autoplay = true;

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'user' },
            width: { ideal: 1080 },
            height: { ideal: 1440 },
          },
          audio: false,
        });
      } catch (error) {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }

      state.stream = stream;
      video.srcObject = stream;

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Kamera timeout saat memuat preview.')), 8000);
        video.onloadedmetadata = async () => {
          clearTimeout(timeout);
          try { await video.play(); } catch (_) {}
          resolve();
        };
      });

      video.classList.add('is-ready');
      if (empty) empty.style.display = 'none';
      if (chip) chip.textContent = 'Kamera aktif';
      stage?.classList.add('camera-live');
      updateRoCameraToggleLabel();
      updateAttendanceCameraToggleLabel();
      showToast('Kamera aktif', 'Akses kamera berhasil. Kamu bisa scan sekarang.', 'success');
    } catch (error) {
      console.error(error);
      if (chip) chip.textContent = 'Gagal membuka kamera';
      showToast('Gagal membuka kamera', error?.message || 'Pastikan halaman dibuka lewat localhost / https dan izin kamera aktif.', 'error');
    }
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
      state.stream = null;
    }
    const { stage, video, empty, chip } = getCameraRefs();
    if (video) {
      video.pause?.();
      video.srcObject = null;
      video.classList.remove('is-ready');
    }
    if (empty) empty.style.display = '';
    if (chip) chip.textContent = 'Kamera belum aktif';
    stage?.classList.remove('camera-live');
    updateRoCameraToggleLabel();
    updateAttendanceCameraToggleLabel();
  }

  async function processFaceMode(forceMode) {
    const mode = forceMode || 'auto';
    const memberId = Number($('#faceMemberId')?.value || 0);
    const meetingId = Number($('#attendanceMeetingId')?.value || 0);
    if (!memberId) {
      showToast('Pilih anggota dulu', 'Scan otomatis tetap butuh anggota yang dipilih.', 'error');
      return;
    }
    if (!meetingId) {
      showToast('Pilih sesi rapat', 'Scan otomatis butuh sesi rapat yang aktif.', 'error');
      return;
    }
    if (!state.stream) {
      showToast('Nyalakan kamera dulu', 'Kamera wajib aktif sebelum ambil frame.', 'error');
      return;
    }

    const trigger = $('#btnTakeAttendance');
    setButtonLoading(trigger, true, 'Memproses scan...');
    showProcessingOverlay('Memproses scan kehadiran...');
    try {
      const blob = await captureFrameAsBlob();
      const fileName = `${Date.now()}-${memberId}.jpg`;
      const existingFaces = state.faceProfiles.filter((row) => Number(row.member_id) === memberId);
      const alreadyRegistered = existingFaces.length > 0;
      if (!alreadyRegistered) {
        const profilePath = `face-profiles/member-${memberId}/${fileName}`;
        await uploadImage(profilePath, blob);
        const { error: profileError } = await state.db.from('face_profiles').insert({ member_id: memberId, image_path: profilePath, is_primary: existingFaces.length === 0 });
        if (profileError) throw profileError;
        upsertManualFaceProfile({ member_id: memberId, image_path: profilePath });
      }

      if (alreadyRegistered) upsertManualFaceProfile({ member_id: memberId });
      const attendancePath = `attendance/meeting-${meetingId}/member-${memberId}/${fileName}`;
      await uploadImage(attendancePath, blob);
      const { error: attendanceError } = await state.db.from('attendance').insert({
        meeting_id: meetingId,
        member_id: memberId,
        scan_image_path: attendancePath,
        matched: true,
        confidence: alreadyRegistered ? 100 : 98,
      });
      if (attendanceError) throw attendanceError;

      await primeCoreData();
      updateAttendanceSidebar();
      renderAttendanceRosterTable();
      updateScanLogList();
      showToast(alreadyRegistered ? 'Absensi disimpan' : 'Wajah didaftarkan otomatis', alreadyRegistered ? 'Wajah sudah ada di database, jadi scan langsung dicocokkan dan absensi disimpan.' : 'Wajah belum ada di database, jadi langsung didaftarkan lalu absensinya ikut disimpan.', 'success');
    } catch (error) {
      console.error(error);
      showToast('Gagal memproses scan', error.message || 'Periksa bucket storage dan izin insert tabel.', 'error');
    } finally {
      hideProcessingOverlay();
      setButtonLoading(trigger, false);
    }
  }

  async function uploadImage(path, blob) {
    const { error } = await state.db.storage.from(STORAGE_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: true });
    if (error) throw error;
  }

  function captureFrameAsBlob() {
    return new Promise((resolve, reject) => {
      const { video, canvas } = getCameraRefs();
      if (!video || !canvas || !video.srcObject || !video.videoWidth || !video.videoHeight) {
        reject(new Error('Video kamera belum siap.'));
        return;
      }
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Gagal mengambil gambar.')), 'image/jpeg', 0.92);
    });
  }


  async function renderRoPicketPage(isRealtime = false) {
    hydrateRoPicketPage();
    bindRoPicketActions();
    renderRoPicketTables();
    updateRoPicketSidebar();
    if (isRealtime) showToast('Piket RO diperbarui', 'Jadwal hari ini, status scan, dan daftar yang belum piket sudah sinkron.', 'success');
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function parseLocalDateOnly(dateString) {
    const match = String(dateString || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
  }

  function toISODateLocal(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function getTodayISODate() {
    return toISODateLocal(new Date());
  }

  function getWeekMondayISO(dateString = getTodayISODate()) {
    const d = parseLocalDateOnly(dateString) || new Date(dateString);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return toISODateLocal(d);
  }

  function addDaysISO(dateString, days) {
    const d = parseLocalDateOnly(dateString) || new Date(dateString);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + Number(days || 0));
    return toISODateLocal(d);
  }

  function getReferenceSchoolWeekStart(dateString = getTodayISODate()) {
    const monday = getWeekMondayISO(dateString);
    const d = parseLocalDateOnly(dateString) || new Date(dateString);
    const day = d.getDay();
    return (day === 0 || day === 6) ? addDaysISO(monday, 7) : monday;
  }

  function resolveActiveCashWeek(weeks) {
    const ordered = getOrderedCashWeeks(weeks);
    return ordered[0] || null;
  }

  function getOrderedCashWeeks(sourceWeeks = state.weeks) {
    const weekMap = new Map(
      [...(Array.isArray(sourceWeeks) ? sourceWeeks : [])]
        .filter((week) => week && week.cycle_start)
        .map((week) => [String(week.cycle_start), { ...week }])
    );

    const reference = getReferenceSchoolWeekStart();
    const generated = Array.from({ length: 4 }, (_, index) => {
      const cycleStart = addDaysISO(reference, index * 7);
      const realWeek = weekMap.get(String(cycleStart));
      return {
        ...(realWeek || {}),
        cycle_start: cycleStart,
        synthetic: !realWeek,
        sequence_label: `Minggu ${index + 1}`,
      };
    });

    return generated;
  }

  function getCashWeekMeta(cycleStart) {
    return getOrderedCashWeeks().find((week) => String(week.cycle_start) === String(cycleStart)) || null;
  }

  function getActiveMembers() {
    return state.members.filter((member) => member && member.is_active !== false);
  }

  function getSafeUntilDate(cycleStart) {
    if (!cycleStart) return '';
    const safeDow = Number(state.appSettings?.safe_until_dow || 3);
    return addDaysISO(cycleStart, Math.max(safeDow - 1, 0));
  }

  function isCashWeekDue(cycleStart, today = getTodayISODate()) {
    if (!cycleStart) return false;
    return String(today) > String(getSafeUntilDate(cycleStart));
  }

  function daysBetweenISO(startDate, endDate) {
    const start = parseLocalDateOnly(startDate);
    const end = parseLocalDateOnly(endDate);
    if (!start || !end) return 0;
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    return Math.round((end.getTime() - start.getTime()) / 86400000);
  }

  function buildDefaultCashRow(member, cycleStart) {
    const weeklyFee = Number(state.appSettings?.weekly_fee || 0);
    const finePerDay = Number(state.appSettings?.fine_per_day || 0);
    const today = getTodayISODate();
    const safeUntilDate = getSafeUntilDate(cycleStart);
    const due = isCashWeekDue(cycleStart, today);
    let lateDays = 0;
    if (due && safeUntilDate) {
      lateDays = Math.max(daysBetweenISO(safeUntilDate, today), 0);
    }
    const fine = due ? finePerDay * lateDays : 0;
    return {
      member_id: member.id,
      full_name: member.full_name,
      cycle_start: cycleStart,
      is_paid: false,
      paid_at: null,
      paid_base_amount: 0,
      paid_fine_amount: 0,
      paid_amount: 0,
      base_amount: weeklyFee,
      current_late_days: lateDays,
      current_fine_amount: fine,
      outstanding_total_today: weeklyFee + fine,
      safe_until_date: safeUntilDate,
    };
  }

  function buildCashDisplayRows(rawRows = [], cycleStart = '') {
    const members = getActiveMembers();
    const map = new Map((Array.isArray(rawRows) ? rawRows : []).map((row) => [Number(row.member_id), { ...row }]));
    return members.map((member) => {
      const targetCycle = cycleStart || state.currentWeek?.cycle_start || '';
      const existing = map.get(Number(member.id));
      let row = existing
        ? {
            ...buildDefaultCashRow(member, targetCycle || existing.cycle_start || ''),
            ...existing,
            full_name: existing.full_name || member.full_name,
            cycle_start: existing.cycle_start || targetCycle || '',
          }
        : buildDefaultCashRow(member, targetCycle);

      if (!row.is_paid && (row.paid_at || Number(row.paid_amount || 0) > 0 || Number(row.paid_base_amount || 0) > 0)) {
        row = derivePaidCashFields(row, member.id, row.cycle_start || targetCycle);
      }

      const manual = getManualCashPayment(member.id, row.cycle_start || targetCycle);
      if (manual) row = { ...row, ...derivePaidCashFields({ ...row, ...manual }, member.id, manual.cycle_start || row.cycle_start || targetCycle) };

      const targetStart = String(row.cycle_start || targetCycle || '');
      const targetEnd = targetStart ? addDaysISO(targetStart, 4) : '';
      const paidFact = getCashPaidFactRows().find((fact) => Number(fact.member_id) === Number(member.id) && ((fact.cycle_start && String(fact.cycle_start) === targetStart) || (fact.paid_at && targetStart && String(fact.paid_at).slice(0,10) >= targetStart && String(fact.paid_at).slice(0,10) <= targetEnd)));
      if (paidFact) row = { ...row, ...derivePaidCashFields({ ...row, ...paidFact }, member.id, targetStart) };

      return row;
    }).sort((a, b) => String(a.full_name || '').localeCompare(String(b.full_name || ''), 'id'));
  }

  function summarizeCashRows(rows = [], cycleStart = '') {
    const due = isCashWeekDue(cycleStart);
    const source = Array.isArray(rows) ? rows : [];
    return {
      isDue: due,
      outstandingMembers: due ? source.filter((row) => !row.is_paid).length : 0,
      outstandingActive: due ? source.filter((row) => !row.is_paid).reduce((sum, row) => sum + Number(row.outstanding_total_today || row.base_amount || 0), 0) : 0,
    };
  }

  function getRoWeekGroups() {
    const groups = new Map();
    state.roPicketSchedule.forEach((row) => {
      const weekStart = getWeekMondayISO(String(row.duty_date));
      if (!groups.has(weekStart)) groups.set(weekStart, {
        week_start: weekStart,
        week_end: addDaysISO(weekStart, 4),
        sessions: [],
      });
      groups.get(weekStart).sessions.push(row);
    });

    const reference = getReferenceSchoolWeekStart();
    const generated = Array.from({ length: 4 }, (_, index) => {
      const weekStart = addDaysISO(reference, index * 7);
      const existing = groups.get(weekStart);
      return {
        week_start: weekStart,
        week_end: addDaysISO(weekStart, 4),
        sessions: existing?.sessions || [],
        synthetic: !existing,
        sequence_label: `Minggu ${index + 1}`,
      };
    });

    return generated;
  }

  function resolveActiveRoWeekStart() {
    const groups = getRoWeekGroups();
    return groups[0]?.week_start || '';
  }

  function getRoSessions() {
    const selectedWeekStart = state.selectedRoWeekStart || resolveActiveRoWeekStart();
    const groups = getRoWeekGroups();
    const activeGroup = groups.find((group) => String(group.week_start) === String(selectedWeekStart)) || groups[0] || null;
    if (!activeGroup) return [];

    const map = new Map();
    activeGroup.sessions.forEach((row) => {
      if (!map.has(row.session_id)) map.set(row.session_id, {
        session_id: row.session_id,
        title: row.title,
        duty_date: row.duty_date,
        day_name: row.day_name,
        note: row.note,
        is_open: row.is_open,
      });
    });
    return Array.from(map.values()).sort((a, b) => String(a.duty_date).localeCompare(String(b.duty_date)));
  }

  function getPreferredRoSession(sessions) {
    const today = getTodayISODate();
    const todaySession = sessions.find((session) => String(session.duty_date) === today && session.is_open !== false);
    if (todaySession) return todaySession;
    const openSession = sessions.find((session) => session.is_open !== false);
    return openSession || sessions[0] || null;
  }

  function formatSchoolWeekLabelFromDate(dateString) {
    if (!dateString) return '-';
    const start = getWeekMondayISO(dateString);
    const end = addDaysISO(start, 4);
    return `${formatDate(start)} - ${formatDate(end)}`;
  }

  function renderRomWeekChips() {
    const wrap = $('#romWeekChipList');
    if (!wrap) return;
    const groups = getRoWeekGroups();
    const activeWeekStart = state.selectedRoWeekStart || resolveActiveRoWeekStart();
    wrap.innerHTML = groups.map((group) => `
      <button type="button" class="week-chip ${String(group.week_start) === String(activeWeekStart) ? 'active' : ''}" data-rom-week="${group.week_start}">
        <strong>${group.sequence_label}</strong>
        <span>${formatDate(group.week_start)} - ${formatDate(group.week_end)}</span>
      </button>
    `).join('');
    wrap.querySelectorAll('[data-rom-week]').forEach((button) => {
      button.addEventListener('click', () => {
        state.selectedRoWeekStart = String(button.getAttribute('data-rom-week') || '');
        const sessions = getRoSessions();
        const preferred = getPreferredRoSession(sessions);
        const select = $('#roPicketSessionId');
        if (select) select.value = String(preferred?.session_id || '');
        renderRomWeekChips();
        renderRomDayChips();
        syncRoMemberSelection();
        updateRoAutoTargetLabel();
        renderRoPicketTables();
        updateRoPicketSidebar();
      });
    });
  }

  function renderRomDayChips() {
    const wrap = $('#romDayChipList');
    if (!wrap) return;
    const sessions = getRoSessions();
    const activeId = Number($('#roPicketSessionId')?.value || getPreferredRoSession(sessions)?.session_id || 0);
    wrap.innerHTML = sessions.map((session) => `
      <button type="button" class="day-chip ${Number(session.session_id) === activeId ? 'active' : ''}" data-rom-session="${session.session_id}">${escapeHtml(session.day_name || '')} - ${formatDate(session.duty_date)}</button>
    `).join('');
    wrap.querySelectorAll('[data-rom-session]').forEach((button) => {
      button.addEventListener('click', () => {
        const select = $('#roPicketSessionId');
        if (select) select.value = String(button.getAttribute('data-rom-session') || '');
        renderRomWeekChips();
        renderRomDayChips();
        syncRoMemberSelection();
        updateRoAutoTargetLabel();
        renderRoPicketTables();
        updateRoPicketSidebar();
      });
    });
  }

  function updateRomWeekLabel() {
    const groups = getRoWeekGroups();
    const activeWeekStart = state.selectedRoWeekStart || resolveActiveRoWeekStart();
    const activeGroup = groups.find((group) => String(group.week_start) === String(activeWeekStart)) || groups[0] || null;
    const label = $('#romWeekLabel');
    if (label) label.textContent = activeGroup ? `${activeGroup.sequence_label} - ${formatDate(activeGroup.week_start)} - ${formatDate(activeGroup.week_end)}` : 'Minggu sekolah belum tersedia';
  }

  function hydrateRoPicketPage() {
    const groups = getRoWeekGroups();
    if (!groups.some((group) => String(group.week_start) === String(state.selectedRoWeekStart || ''))) {
      state.selectedRoWeekStart = groups[0]?.week_start || '';
    }
    const sessions = getRoSessions();
    const sessionSelect = $('#roPicketSessionId');
    if (sessionSelect) {
      sessionSelect.innerHTML = `<option value="">Pilih sesi piket</option>` + sessions.map((session) => `<option value="${session.session_id}">${escapeHtml(session.day_name || '')} - ${escapeHtml(session.title)} - ${formatDate(session.duty_date)}</option>`).join('');
      const preferred = getPreferredRoSession(sessions);
      if (preferred) sessionSelect.value = String(preferred.session_id);
    }
    updateRomWeekLabel();
    renderRomWeekChips();
    renderRomDayChips();

    const emptyState = $('.camera-empty-state', $('#cameraStage')) || document.createElement('div');
    if (!emptyState.classList.contains('camera-empty-state')) {
      emptyState.className = 'camera-empty-state';
      $('#cameraStage')?.appendChild(emptyState);
    }
    emptyState.innerHTML = `<div><strong>Kamera siap diaktifkan</strong><span>Arahkan wajah petugas ke area frame lalu tekan scan untuk menandai piket selesai.</span></div>`;

    syncRoMemberSelection();
    updateRoAutoTargetLabel();
    updateRoCameraToggleLabel();
    updateRoPicketSidebar();
  }

  function bindRoPicketActions() {
    const panel = $('#cameraStage');
    if (!panel) return;

    const toggleBtn = $('#btnToggleRoCamera');
    if (toggleBtn && toggleBtn.dataset.bound !== 'true') {
      toggleBtn.dataset.bound = 'true';
      toggleBtn.addEventListener('click', async (event) => {
        event.preventDefault();
        if (state.stream) {
          stopCamera();
          updateRoCameraToggleLabel();
        } else {
          await startCamera();
          updateRoCameraToggleLabel();
        }
      });
    }

    const takeBtn = $('#btnTakeRoPicket');
    if (takeBtn && takeBtn.dataset.bound !== 'true') {
      takeBtn.dataset.bound = 'true';
      takeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        processRoPicketScan();
      });
    }

    const sessionSelect = $('#roPicketSessionId');
    if (sessionSelect && sessionSelect.dataset.bound !== 'true') {
      sessionSelect.dataset.bound = 'true';
      sessionSelect.addEventListener('change', () => {
        const selectedSession = state.roPicketSchedule.find((row) => Number(row.session_id) === Number(sessionSelect.value || 0));
        if (selectedSession?.duty_date) state.selectedRoWeekStart = getWeekMondayISO(String(selectedSession.duty_date));
        renderRomWeekChips();
        renderRomDayChips();
        syncRoMemberSelection();
        updateRoAutoTargetLabel();
        renderRoPicketTables();
        updateRoPicketSidebar();
      });
    }
  }

  function updateRoCameraToggleLabel() {
    const btn = $('#btnToggleRoCamera');
    if (!btn) return;
    btn.textContent = state.stream ? 'Matikan Kamera' : 'Nyalakan Kamera';
  }

  function syncRoMemberSelection() {
    const sessionId = Number($('#roPicketSessionId')?.value || 0);
    const memberSelect = $('#roPicketMemberId');
    if (!memberSelect) return;
    if (!sessionId) {
      memberSelect.innerHTML = `<option value="">Pilih anggota</option>`;
      return;
    }

    const scheduleRows = state.roPicketSchedule.filter((row) => Number(row.session_id) === sessionId);
    const recentRows = state.roPicketRecent.filter((row) => Number(row.session_id) === sessionId);
    const rows = scheduleRows.map((row) => ({
      ...row,
      alreadyScanned: recentRows.some((scan) => Number(scan.member_id) === Number(row.member_id)),
    })).sort((a, b) => Number(a.alreadyScanned) - Number(b.alreadyScanned) || String(a.full_name).localeCompare(String(b.full_name)));

    memberSelect.innerHTML = `<option value="">Pilih anggota</option>` + rows.map((row) => `<option value="${row.member_id}">${escapeHtml(row.full_name)}${row.alreadyScanned ? ' — sudah scan' : ''}</option>`).join('');

    const currentValue = Number(memberSelect.value || 0);
    const currentStillValid = rows.find((row) => Number(row.member_id) === currentValue && !row.alreadyScanned);
    const firstPending = rows.find((row) => !row.alreadyScanned) || rows[0] || null;
    const target = currentStillValid || firstPending;
    if (target) memberSelect.value = String(target.member_id);
  }

  function updateRoAutoTargetLabel() { return; }

  function updateRoPicketSidebar() {
    const sessionId = Number($('#roPicketSessionId')?.value || 0);
    const sessions = getRoSessions();
    const preferred = getPreferredRoSession(sessions);
    const session = sessions.find((item) => Number(item.session_id) === sessionId) || preferred || null;
    const summary = $('#picketSessionSummary');
    if (!summary) return;
    if (!session) {
      summary.textContent = 'Belum ada sesi piket untuk hari ini';
      $('#picketTodayAssigned') && ($('#picketTodayAssigned').textContent = '0');
      $('#picketTodayDone') && ($('#picketTodayDone').textContent = '0');
      $('#picketTodayPending') && ($('#picketTodayPending').textContent = '0');
      return;
    }

    const assignedRows = state.roPicketSchedule.filter((row) => Number(row.session_id) === Number(session.session_id));
    const recentRows = state.roPicketRecent.filter((row) => Number(row.session_id) === Number(session.session_id));
    const assigned = assignedRows.length;
    const done = recentRows.length;
    const pending = Math.max(assigned - done, 0);

    summary.textContent = `${session.day_name || session.title} - ${formatDate(session.duty_date)}`;
    updateRomWeekLabel();
    $('#picketTodayAssigned') && ($('#picketTodayAssigned').textContent = String(assigned));
    $('#picketTodayDone') && ($('#picketTodayDone').textContent = String(done));
    $('#picketTodayPending') && ($('#picketTodayPending').textContent = String(pending));
  }

  function renderRoPicketSessionCards() {
    return;
  }

  function renderRoPicketTables() {
    const rosterBody = $('#roPicketRosterTable');
    const recentList = $('#roPicketRecentList');
    const sessionId = Number($('#roPicketSessionId')?.value || 0);
    const sessions = getRoSessions();
    const preferred = getPreferredRoSession(sessions);
    const activeSessionId = sessionId || Number(preferred?.session_id || 0);

    const scheduleRows = activeSessionId ? state.roPicketSchedule.filter((row) => Number(row.session_id) === activeSessionId) : [];
    const recentRows = activeSessionId ? state.roPicketRecent.filter((row) => Number(row.session_id) === activeSessionId) : [];

    const mergedRows = scheduleRows.map((row) => {
      const scanned = recentRows.find((item) => Number(item.member_id) === Number(row.member_id));
      return { ...row, scanned_at: scanned?.scanned_at || null, already_scanned: !!scanned };
    }).sort((a, b) => Number(a.already_scanned) - Number(b.already_scanned) || String(a.full_name).localeCompare(String(b.full_name)));

    if (rosterBody) rosterBody.innerHTML = mergedRows.length
      ? mergedRows.map((row) => `
        <tr>
          <td>${escapeHtml(row.full_name || '-')}</td>
          <td>${row.already_scanned ? '<span class="pill success">Sudah scan</span>' : '<span class="pill danger">Belum piket</span>'}</td>
          <td>${renderDateTimeCell(row.scanned_at)}</td>
        </tr>
      `).join('')
      : `<tr><td colspan="3">Belum ada jadwal piket untuk sesi ini.</td></tr>`;

    if (recentList) recentList.innerHTML = recentRows.length
      ? recentRows.slice(0, 8).map((row) => `<li><strong>${escapeHtml(row.full_name || '-')}</strong><span>${formatDateTime(row.scanned_at)} - ${escapeHtml(row.title || '-')}</span></li>`).join('')
      : `<li><strong>Belum ada scan piket</strong><span>Gunakan kamera untuk mulai scan piket ROM.</span></li>`;
    renderRomWeekChips();
    renderRomDayChips();
  }

  async function processRoPicketScan() {
    const sessionId = Number($('#roPicketSessionId')?.value || 0);
    const memberId = Number($('#roPicketMemberId')?.value || 0);
    if (!sessionId) { showToast('Tidak ada sesi aktif', 'Halaman ini otomatis fokus ke sesi hari ini. Kalau kosong, berarti sesi hari ini belum dibuat.', 'error'); return; }
    if (!memberId) { showToast('Pilih petugas dulu', 'Pilih salah satu anggota yang memang dijadwalkan hari ini.', 'error'); return; }
    if (!state.stream) { showToast('Nyalakan kamera dulu', 'Kamera wajib aktif sebelum ambil frame.', 'error'); return; }
    const allowed = state.roPicketSchedule.some((row) => Number(row.session_id) === sessionId && Number(row.member_id) === memberId);
    if (!allowed) { showToast('Bukan jadwal piket', 'Anggota ini tidak terdaftar pada sesi piket yang dipilih.', 'error'); return; }
    const trigger = $('#btnTakeRoPicket');
    setButtonLoading(trigger, true, 'Memproses scan...');
    showProcessingOverlay('Memproses scan piket ROM...');
    try {
      const blob = await captureFrameAsBlob();
      const fileName = `${Date.now()}-${memberId}.jpg`;
      const existingFaces = state.faceProfiles.filter((row) => Number(row.member_id) === memberId);
      if (!existingFaces.length) {
        const profilePath = `face-profiles/member-${memberId}/${fileName}`;
        await uploadImage(profilePath, blob);
        const { error: profileError } = await state.db.from('face_profiles').insert({ member_id: memberId, image_path: profilePath, is_primary: true });
        if (profileError) throw profileError;
        upsertManualFaceProfile({ member_id: memberId, image_path: profilePath });
      }
      if (existingFaces.length) upsertManualFaceProfile({ member_id: memberId });
      const scanPath = `ro-picket/session-${sessionId}/member-${memberId}/${fileName}`;
      await uploadImage(scanPath, blob);
      const { error } = await state.db.rpc('mark_ro_picket_scan', {
        p_session_id: sessionId,
        p_member_id: memberId,
        p_scan_image_path: scanPath,
        p_scanned_at: new Date().toISOString(),
        p_note: 'Scan piket RO via web',
      });
      if (error) throw error;
      await primeCoreData();
      syncRoMemberSelection();
      updateRoAutoTargetLabel();
      renderRoPicketTables();
      updateRoPicketSidebar();
      showToast('Piket berhasil dicatat', 'Scan wajah berhasil menandai petugas sudah piket RO.', 'success');
    } catch (error) {
      console.error(error);
      showToast('Gagal scan piket RO', error.message || 'Periksa bucket storage, RPC mark_ro_picket_scan, dan izin tabel.', 'error');
    } finally {
      hideProcessingOverlay();
      setButtonLoading(trigger, false);
    }
  }

  async function renderReportsPage(isRealtime = false) {
    const grid = $('#reportStatsGrid');
    if (grid && state.globalSummary) {
      const avgAttendance = state.members.length ? Math.round((state.attendanceRecent.filter((row) => row.matched).length / Math.max(state.attendanceRecent.length, 1)) * 100) : 0;
      const topMember = state.weeklyStatus.find((row) => row.is_paid)?.full_name || state.members[0]?.full_name || '-';
      grid.innerHTML = `
        <article class="stat-card"><span class="stat-label">Pemasukan Total</span><strong>${formatMoney(state.globalSummary.grand_total_collected)}</strong></article>
        <article class="stat-card"><span class="stat-label">Denda Terkumpul</span><strong>${formatMoney(state.globalSummary.fine_total_collected)}</strong></article>
        <article class="stat-card"><span class="stat-label">Rata-rata Match Scan</span><strong>${avgAttendance}%</strong></article>
        <article class="stat-card"><span class="stat-label">Anggota Cepat Bayar</span><strong>${escapeHtml(topMember)}</strong></article>
      `;
    }
    renderReportBlocks();
    renderReportTable();
    if (isRealtime) showToast('Laporan diperbarui', 'Angka terbaru sudah tersinkron ke halaman laporan.', 'success');
  }

  function renderReportBlocks() {
    const cash = $('#reportCashChart');
    const attendance = $('#reportAttendanceChart');
    if (cash) {
      const total = Number(state.globalSummary?.grand_total_collected || 0) || 1;
      const basePct = Math.round((Number(state.globalSummary?.cash_total_collected || 0) / total) * 100);
      const finePct = Math.round((Number(state.globalSummary?.fine_total_collected || 0) / total) * 100);
      cash.innerHTML = `
        <div class="report-mini-bars">
          <div><div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span>Kas Pokok</span><strong>${basePct}%</strong></div><div class="bar-track"><span class="bar-fill" data-width="${basePct}%"></span></div></div>
          <div><div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span>Denda</span><strong>${finePct}%</strong></div><div class="bar-track"><span class="bar-fill" data-width="${finePct}%"></span></div></div>
          <div><div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span>Tunggakan tersisa</span><strong>${formatMoney(state.globalSummary?.outstanding_now || 0)}</strong></div><div class="bar-track"><span class="bar-fill" data-width="${Math.min(100, Math.round((Number(state.globalSummary?.outstanding_now || 0) / total) * 100))}%"></span></div></div>
        </div>
      `;
    }
    if (attendance) {
      const matched = state.attendanceRecent.filter((row) => row.matched).length;
      const unmatched = state.attendanceRecent.length - matched;
      const matchPct = state.attendanceRecent.length ? Math.round((matched / state.attendanceRecent.length) * 100) : 0;
      const unmatchedPct = state.attendanceRecent.length ? Math.round((unmatched / state.attendanceRecent.length) * 100) : 0;
      attendance.innerHTML = `
        <div class="report-mini-bars">
          <div><div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span>Scan cocok</span><strong>${matchPct}%</strong></div><div class="bar-track"><span class="bar-fill" data-width="${matchPct}%"></span></div></div>
          <div><div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span>Butuh validasi</span><strong>${unmatchedPct}%</strong></div><div class="bar-track"><span class="bar-fill" data-width="${unmatchedPct}%"></span></div></div>
        </div>
      `;
    }
    $$('.bar-fill').forEach((bar, index) => setTimeout(() => { bar.style.width = bar.dataset.width || '0%'; }, 120 + index * 120));
  }

  function renderReportTable() {
    const tbody = $('#reportTableBody');
    if (!tbody) return;
    tbody.innerHTML = state.weeks.length ? state.weeks.slice(0, 8).map((row) => {
      const attendancePct = state.members.length ? Math.round(((Number(row.paid_members || 0)) / Math.max(Number(row.members_total || 0), 1)) * 100) : 0;
      return `
        <tr>
          <td>${formatSchoolWeekLabel(row.cycle_start)}</td>
          <td>${formatMoney(row.base_collected)}</td>
          <td>${formatMoney(row.fine_collected)}</td>
          <td>${formatMoney(row.total_collected)}</td>
          <td>${attendancePct}%</td>
          <td><span class="pill ${Number(row.unpaid_members || 0) === 0 ? 'success' : Number(row.unpaid_members || 0) > 5 ? 'warning' : 'primary'}">${Number(row.unpaid_members || 0) === 0 ? 'Stabil' : `${row.unpaid_members} belum lunas`}</span></td>
        </tr>
      `;
    }).join('') : `<tr><td colspan="6">Belum ada data laporan mingguan.</td></tr>`;
  }

  async function renderSettingsPage(isRealtime = false) {
    if (!state.appSettings) return;
    const cash = $('#settingsCashList');
    const attendance = $('#settingsAttendanceList');
    if (cash) {
      cash.innerHTML = `
        <div class="setting-item"><span>Kas mingguan</span><strong>${formatMoney(state.appSettings.weekly_fee)}</strong></div>
        <div class="setting-item"><span>Hari aman</span><strong>Senin - ${DAY_MAP[state.appSettings.safe_until_dow] || '-'}</strong></div>
        <div class="setting-item"><span>Denda per hari</span><strong>${formatMoney(state.appSettings.fine_per_day)}</strong></div>
        <div class="setting-item"><span>Validasi pembayaran</span><strong>RPC treasurer_mark_cash_payment</strong></div>
      `;
    }
    if (attendance) {
      const avgConfidence = state.attendanceRecent.length ? Math.round(state.attendanceRecent.reduce((sum, row) => sum + Number(row.confidence || 0), 0) / state.attendanceRecent.length) : 100;
      attendance.innerHTML = `
        <div class="setting-item"><span>Ambang confidence</span><strong>${avgConfidence}%</strong></div>
        <div class="setting-item"><span>Fallback manual</span><strong>Aktif via form absensi</strong></div>
        <div class="setting-item"><span>Wajah per anggota</span><strong>${Math.max(...[0, ...Object.values(Object.fromEntries(groupCount(state.faceProfiles, 'member_id')))]) || 0} file maksimum terdeteksi</strong></div>
        <div class="setting-item"><span>Sinkronisasi log</span><strong>Realtime listener aktif</strong></div>
      `;
    }
    if (isRealtime) showToast('Pengaturan terbarui', 'Nilai settings terbaru sudah dimuat.', 'success');
  }


  function showProcessingOverlay(message = 'Memproses data...') {
    try {
      if (window.MPKLoader && typeof window.MPKLoader.show === 'function') window.MPKLoader.show(message);
    } catch (_) {}
  }

  function hideProcessingOverlay() {
    try {
      if (window.MPKLoader && typeof window.MPKLoader.hide === 'function') window.MPKLoader.hide();
    } catch (_) {}
  }

  function promptForPassword(options = {}) {
    const title = options.title || 'Password Bendahara';
    const description = options.description || 'Masukkan password untuk menyimpan pembayaran kas.';
    const label = options.label || 'Password bendahara';
    const placeholder = options.placeholder || 'Masukkan password';
    const confirmText = options.confirmText || 'Lanjut';
    const variant = options.variant || '';
    return new Promise((resolve) => {
      const content = document.createElement('div');
      content.innerHTML = `
        <div class="form-grid">
          <label class="full">
            <span>${escapeHtml(label)}</span>
            <input id="treasurerPasswordModalInput" type="password" placeholder="${escapeHtmlAttr(placeholder)}" autocomplete="current-password" />
          </label>
          <div class="form-actions full">
            <button type="button" class="btn btn-ghost" data-close-modal>Batal</button>
            <button type="button" class="btn btn-primary" id="confirmTreasurerPasswordBtn">${escapeHtml(confirmText)}</button>
          </div>
        </div>
      `;
      const modal = openModal(title, description, content, false, variant);
      const input = $('#treasurerPasswordModalInput', modal);
      const confirmBtn = $('#confirmTreasurerPasswordBtn', modal);
      const cancelBtn = $('[data-close-modal]', modal);
      const finish = (value) => {
        closeModal(modal);
        resolve((value || '').trim());
      };
      setTimeout(() => input?.focus(), 40);
      confirmBtn?.addEventListener('click', () => finish(input?.value || ''));
      cancelBtn?.addEventListener('click', () => resolve(''));
      input?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(input?.value || '');
        }
      });
    });
  }

  function openModal(title, description, content, large = false, variant = '') {
    const root = $('#appModalRoot') || document.body;
    const backdrop = document.createElement('div');
    backdrop.className = 'app-modal-backdrop';
    backdrop.innerHTML = `<div class="app-modal ${large ? 'large' : ''} ${variant || ''}"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div>`;
    const modal = $('.app-modal', backdrop);
    if (content instanceof HTMLElement) modal.appendChild(content); else modal.insertAdjacentHTML('beforeend', String(content));
    root.appendChild(backdrop);
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeModal(backdrop); });
    backdrop.querySelectorAll('[data-close-modal]').forEach((btn) => btn.addEventListener('click', () => closeModal(backdrop)));
    return backdrop;
  }

  function closeModal(modal) {
    if (!modal) return;
    modal.dispatchEvent(new CustomEvent('close-modal-intent'));
    modal.remove();
  }

  function showToast(title, message, mode = 'info') {
    let stack = $('.live-toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'live-toast-stack';
      document.body.appendChild(stack);
    }
    const toast = document.createElement('div');
    toast.className = `live-toast ${mode}`;
    toast.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span>`;
    stack.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('is-show'));
    setTimeout(() => {
      toast.classList.remove('is-show');
      setTimeout(() => toast.remove(), 240);
    }, 2800);
  }

  function exportCurrentPageTable(filename) {
    const table = $('table');
    if (!table) {
      showToast('Belum ada data tabel', 'Halaman ini belum punya tabel untuk diekspor.', 'warning');
      return;
    }
    const rows = $$('tr', table).map((row) => $$('th,td', row).map((cell) => csvEscape(cell.textContent.trim())).join(',')).join('\n');
    const blob = new Blob([rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    showToast('Ekspor siap', `File ${filename} berhasil dibuat dari tabel saat ini.`, 'success');
  }

  function csvEscape(value) {
    return `"${String(value || '').replaceAll('"', '""')}"`;
  }

  function setButtonLoading(button, loading, text = 'Memproses...') {
    if (!button) return;
    if (loading) {
      button.dataset.originalText = button.textContent;
      button.disabled = true;
      button.textContent = text;
    } else {
      button.disabled = false;
      button.textContent = button.dataset.originalText || button.textContent;
    }
  }

  function formatMoney(value) {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(value || 0));
  }

  function formatDate(value) {
    if (!value) return '-';
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? parseLocalDateOnly(String(value)) : new Date(value);
    return new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }).format(normalized);
  }

  function formatTime(value) {
    if (!value) return '-';
    return new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }

  function formatDateTime(value) {
    if (!value) return '-';
    return new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }

  function renderDateTimeCell(value) {
    if (!value) return '<span class="scan-datetime-empty">-</span>';
    return `
      <div class="scan-datetime">
        <span class="scan-date">${escapeHtml(formatDate(value))}</span>
        <span class="scan-time">${escapeHtml(formatTime(value))}</span>
      </div>
    `;
  }

  function getMondayIsoDate(reference = new Date()) {
    const d = new Date(reference);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0,0,0,0);
    return toISODateLocal(d);
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return parts.map((part) => part[0]?.toUpperCase() || '').join('') || 'A';
  }

  function trimText(value, max) {
    const text = String(value || '');
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function escapeHtml(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function escapeHtmlAttr(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }

  function extractDivision(member) {
    const notes = String(member?.notes || '');
    const match = notes.match(/divisi\s*:\s*([^|]+)/i);
    return match ? match[1].trim() : '';
  }

  function extractRole(member) {
    const notes = String(member?.notes || '');
    const match = notes.match(/jabatan\s*:\s*([^|]+)/i);
    return match ? match[1].trim() : '';
  }

  function findMember(memberId) {
    return state.members.find((item) => Number(item.id) === Number(memberId)) || null;
  }

  function groupCount(rows, key) {
    const map = new Map();
    rows.forEach((row) => map.set(row[key], (map.get(row[key]) || 0) + 1));
    return map;
  }
})();
