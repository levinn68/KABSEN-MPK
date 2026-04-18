(() => {
  const $ = (selector, scope = document) => scope.querySelector(selector);
  let adminPassword = '';
  const FIXED_START_DATE = '2026-04-20';

  document.addEventListener('DOMContentLoaded', init);

  function showStatus(message, mode = 'idle') {
    const note = $('#adminAccessStatus');
    if (!note) return;
    note.textContent = message;
    note.className = `admin-status-note ${mode}`;
  }

  function formatMoney(value) {
    return new Intl.NumberFormat('id-ID').format(Number(value || 0));
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  async function init() {
    if (!window.db) {
      showStatus('Supabase belum siap. Cek config.js dulu.', 'error');
      return;
    }

    $('#btnVerifyAdminAccess')?.addEventListener('click', verifyAccess);
    $('#btnAdminExportAllInOne')?.addEventListener('click', exportAllInOne);
    $('#adminDownloadPanel')?.setAttribute('hidden', 'hidden');
    showStatus('Akses belum dibuka.', 'idle');
  }

  async function verifyAccess() {
    const input = $('#adminPasswordInput');
    const password = String(input?.value || '').trim();
    if (!password) {
      showStatus('Masukkan password admin dulu.', 'error');
      input?.focus();
      return false;
    }

    const btn = $('#btnVerifyAdminAccess');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Memverifikasi...';
    }

    try {
      const { data, error } = await window.db.rpc('verify_admin_export_password', { p_password: password });
      if (error) throw error;
      if (!data) throw new Error('Password admin salah');
      adminPassword = password;
      $('#adminDownloadPanel')?.removeAttribute('hidden');
      showStatus('Akses admin aktif. Rekap all-in-one siap diunduh.', 'success');
      return true;
    } catch (error) {
      $('#adminDownloadPanel')?.setAttribute('hidden', 'hidden');
      showStatus(error.message || 'Password admin salah', 'error');
      return false;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Buka Akses Admin';
      }
    }
  }

  async function exportAllInOne() {
    if (!adminPassword) {
      showStatus('Akses admin belum aktif.', 'error');
      return;
    }

    const startDate = FIXED_START_DATE;
    const endDate = new Date().toISOString().slice(0, 10);

    const btn = $('#btnAdminExportAllInOne');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Menyiapkan rekap...';
    }

    try {
      const { data, error } = await window.db.rpc('admin_export_member_range_summary', {
        p_password: adminPassword,
        p_start_date: startDate,
        p_end_date: endDate,
      });
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      if (!rows.length) throw new Error('Tidak ada data pada rentang tanggal ini.');

      const html = buildHtml(rows, startDate, endDate);
      const blob = new Blob([html], { type: 'text/html;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `rekap-aktivitas-${startDate}-${endDate}.html`;
      link.click();
      URL.revokeObjectURL(url);
      showStatus('Rekap aktivitas berhasil diunduh.', 'success');
    } catch (error) {
      showStatus(error.message || 'Gagal mengunduh rekap all-in-one.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Download Rekap Aktivitas';
      }
    }
  }

  function buildHtml(rows, startDate, endDate) {
    const cards = rows.map((row) => {
      const rapat = row.rapat || {};
      const piket = row.piket_rom || {};
      const kas = row.kas || {};
      return `
        <section class="member-card">
          <h2>${escapeHtml(row.full_name || '-')}</h2>
          <div class="grid">
            <article class="box">
              <h3>Rapat</h3>
              <p>Total rapat: <strong>${Number(rapat.total_rapat || 0)}</strong></p>
              <p>Ikut rapat: <strong>${Number(rapat.ikut_rapat || 0)}</strong></p>
              <p>Tidak rapat: <strong>${Number(rapat.tidak_rapat || 0)}</strong></p>
            </article>
            <article class="box">
              <h3>Piket ROM</h3>
              <p>Total piket: <strong>${Number(piket.total_piket || 0)}</strong></p>
              <p>Piket: <strong>${Number(piket.piket || 0)}</strong></p>
              <p>Tidak piket: <strong>${Number(piket.tidak_piket || 0)}</strong></p>
            </article>
            <article class="box box-full">
              <h3>Kas</h3>
              <div class="kas-grid">
                <p>Bayar kas: <strong>${Number(kas.bayar_kas || 0)}</strong></p>
                <p>Tunggakan: <strong>${Number(kas.tunggakan || 0)}</strong></p>
                <p>Kena denda: <strong>${Number(kas.kena_denda || 0)}</strong></p>
                <p>Total kas pokok: <strong>Rp ${formatMoney(kas.total_kas_pokok || 0)}</strong></p>
                <p>Total denda: <strong>Rp ${formatMoney(kas.total_denda || 0)}</strong></p>
                <p>Total keseluruhan: <strong>Rp ${formatMoney(kas.total_keseluruhan || 0)}</strong></p>
              </div>
            </article>
          </div>
        </section>
      `;
    }).join('');

    return `<!doctype html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Rekap Aktivitas Anggota</title>
  <style>
    body{margin:0;padding:20px;background:#071224;color:#eef2ff;font-family:Inter,Arial,sans-serif}
    h1{margin:0 0 8px;font-size:28px;color:#fff}
    .lead{margin:0 0 20px;color:#cbd5e1}
    .member-card{background:#0f1b33;border:1px solid #2a3d62;border-radius:18px;padding:18px;margin-bottom:18px}
    .member-card h2{margin:0 0 14px;color:#f6d77a}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
    .box{background:#0b1528;border:1px solid #233554;border-radius:14px;padding:14px}
    .box-full{grid-column:1/-1}
    .box h3{margin:0 0 10px;font-size:18px;color:#fff}
    .box p{margin:8px 0;color:#dbe4ff;line-height:1.5}
    .kas-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 16px}
    @media (max-width:700px){.grid,.kas-grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <h1>Rekap Aktivitas Anggota</h1>
  <p class="lead">Periode ${escapeHtml(startDate)} sampai ${escapeHtml(endDate)}</p>
  ${cards || '<p>Tidak ada data.</p>'}
</body>
</html>`;
  }
})();
