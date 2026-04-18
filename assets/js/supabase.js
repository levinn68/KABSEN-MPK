(function () {
  const config = window.APP_CONFIG || {};
  const url = config.SUPABASE_URL;
  const anonKey = config.SUPABASE_ANON_KEY;

  window.db = null;

  if (!window.supabase) {
    console.warn('Supabase library belum termuat. Pastikan CDN supabase-js ada sebelum supabase.js');
    return;
  }

  if (!url || !anonKey || url.includes('YOUR_PROJECT') || anonKey.includes('PASTE_YOUR')) {
    console.warn('Supabase belum dikonfigurasi. Isi assets/js/config.js dulu.');
    return;
  }

  window.db = window.supabase.createClient(url, anonKey);
  console.info('Supabase client siap dipakai lewat window.db');
})();
