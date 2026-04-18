(function(){
  function ensure(){
    let overlay = document.getElementById('mpkGlobalLoader');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'mpkGlobalLoader';
    overlay.className = 'mpk-loader-overlay';
    overlay.setAttribute('aria-hidden','true');
    overlay.innerHTML = `
      <div class="mpk-loader-card" role="status" aria-live="polite" aria-busy="true">
        <div class="spinner-container">
          <div class="spinner"><div class="spinner"><div class="spinner"><div class="spinner"><div class="spinner"><div class="spinner"></div></div></div></div></div></div>
        </div>
        <strong id="mpkLoaderTitle">Memproses...</strong>
        <span id="mpkLoaderText">Tunggu sebentar, data sedang diproses.</span>
      </div>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  function ensureGate(){
    let gate = document.getElementById('mpkSiteGate');
    if (gate) return gate;
    gate = document.createElement('div');
    gate.id = 'mpkSiteGate';
    gate.className = 'mpk-site-gate';
    gate.setAttribute('aria-hidden', 'true');
    gate.innerHTML = `
      <div class="mpk-site-gate__card" role="dialog" aria-modal="true" aria-labelledby="mpkSiteGateTitle">
        <div class="mpk-site-gate__eyebrow">Akses MPK</div>
        <h2 class="mpk-site-gate__title" id="mpkSiteGateTitle">Masuk dulu pakai password</h2>
        <p class="mpk-site-gate__desc">Halaman dibuka khusus untuk anggota MPK. Setelah password benar, tampilan akan normal dan bisa dipakai seperti biasa.</p>
        <label class="mpk-site-gate__field">
          <span>Password akses</span>
          <input id="mpkSiteGateInput" type="password" placeholder="Masukkan password anggota" autocomplete="current-password" />
        </label>
        <div class="mpk-site-gate__actions">
          <button class="mpk-site-gate__button" id="mpkSiteGateButton" type="button">Masuk Sekarang</button>
          <div class="mpk-site-gate__note" id="mpkSiteGateNote">Akses belum dibuka.</div>
        </div>
      </div>`;
    document.body.appendChild(gate);
    return gate;
  }

  function showGateError(message){
    const note = document.getElementById('mpkSiteGateNote');
    if (!note) return;
    note.textContent = message;
    note.classList.add('is-error');
  }

  function clearGateError(message){
    const note = document.getElementById('mpkSiteGateNote');
    if (!note) return;
    note.textContent = message || 'Akses belum dibuka.';
    note.classList.remove('is-error');
  }

  function unlockGate(){
    const gate = document.getElementById('mpkSiteGate');
    document.body.classList.remove('site-lock-active');
    if (gate) {
      gate.classList.remove('is-show');
      gate.setAttribute('aria-hidden', 'true');
    }
  }

  function lockGate(){
    const gate = ensureGate();
    document.body.classList.add('site-lock-active');
    gate.classList.add('is-show');
    gate.setAttribute('aria-hidden', 'false');
    const input = document.getElementById('mpkSiteGateInput');
    window.setTimeout(() => input?.focus(), 50);
  }

  function initSiteGate(){
    const config = window.APP_CONFIG || {};
    const password = String(config.SITE_ACCESS_PASSWORD || '').trim();
    const sessionKey = String(config.SITE_ACCESS_SESSION_KEY || 'mpk_site_access_ok');
    if (!password) return;
    if (window.sessionStorage.getItem(sessionKey) === '1') return;

    const gate = ensureGate();
    const input = gate.querySelector('#mpkSiteGateInput');
    const button = gate.querySelector('#mpkSiteGateButton');

    function tryUnlock(){
      const value = String(input?.value || '').trim();
      if (!value) {
        showGateError('Masukkan password dulu.');
        input?.focus();
        return;
      }
      if (value !== password) {
        showGateError('Password salah. Coba lagi.');
        input?.focus();
        input?.select();
        return;
      }
      window.sessionStorage.setItem(sessionKey, '1');
      clearGateError('Akses berhasil dibuka.');
      unlockGate();
    }

    button?.addEventListener('click', tryUnlock);
    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        tryUnlock();
      }
    });

    clearGateError('Akses belum dibuka.');
    lockGate();
  }

  window.MPKLoader = {
    show(message){
      const overlay = ensure();
      const title = overlay.querySelector('#mpkLoaderTitle');
      const text = overlay.querySelector('#mpkLoaderText');
      if (title) title.textContent = 'Mohon tunggu';
      if (text) text.textContent = message || 'Tunggu sebentar, data sedang diproses.';
      overlay.classList.add('is-show');
      overlay.setAttribute('aria-hidden','false');
    },
    hide(){
      const overlay = document.getElementById('mpkGlobalLoader');
      if (!overlay) return;
      overlay.classList.remove('is-show');
      overlay.setAttribute('aria-hidden','true');
    }
  };

  document.addEventListener('DOMContentLoaded', initSiteGate);
})();
