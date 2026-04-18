document.addEventListener('DOMContentLoaded', () => {
  const page = window.location.pathname.split('/').pop() || 'dashboard.html';
  document.body.dataset.page = page.replace('.html', '');
  if (page === 'anggota.html') {
    document.querySelector('#btnOpenMemberModal')?.remove();
    document.querySelector('#btnImportCsv')?.remove();
  }
});
