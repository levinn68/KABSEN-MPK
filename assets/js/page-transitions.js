document.addEventListener('DOMContentLoaded', () => {
  requestAnimationFrame(() => document.body.classList.add('page-ready'));
  document.querySelectorAll('.btn, .nav-link, .mobile-bottom-dock__link, .week-chip, .day-chip, .timeline-card').forEach((el) => {
    el.classList.add('smooth-target');
  });
});
