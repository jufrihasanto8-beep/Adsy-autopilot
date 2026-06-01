import { logout } from './auth.js';

// ── SIDEBAR ACTIVE STATE ──
export function initSidebar() {
  const current = window.location.pathname.split('/').pop() || 'dashboard.html';

  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    if (item.dataset.page === current) {
      item.classList.add('active');
    }
    item.addEventListener('click', () => {
      window.location.href = item.dataset.page;
    });
  });

  // Logout
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) logoutBtn.addEventListener('click', logout);

  // Autopilot toggle
  const apToggle = document.getElementById('autopilot-toggle');
  if (apToggle) {
    const saved = localStorage.getItem('autopilot_active') === 'true';
    if (saved) apToggle.classList.add('on');

    apToggle.addEventListener('click', () => {
      apToggle.classList.toggle('on');
      const isOn = apToggle.classList.contains('on');
      localStorage.setItem('autopilot_active', isOn);

      const statusText = document.getElementById('autopilot-status-text');
      if (statusText) statusText.textContent = isOn ? 'Berjalan aktif' : 'Tidak aktif';
    });
  }
}

// ── TOAST ──
export function showToast(msg, type = 'default', duration = 3000) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const icons = { success: '✓', error: '✕', warning: '⚠', default: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = `toast ${type !== 'default' ? type : ''}`;
  toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span> ${msg}`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 280);
  }, duration);
}

// ── FORMAT HELPERS ──
export function formatRupiah(n) {
  if (!n && n !== 0) return '-';
  return 'Rp ' + Number(n).toLocaleString('id-ID');
}

export function formatNumber(n) {
  if (!n && n !== 0) return '-';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return Number(n).toLocaleString('id-ID');
}

export function formatDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('id-ID', {
    day: 'numeric', month: 'short', year: 'numeric'
  });
}

export function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'baru saja';
  if (mins < 60) return `${mins} menit lalu`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  return `${days} hari lalu`;
}

// ── MODAL HELPER ──
export function openModal(id) {
  document.getElementById(id)?.classList.remove('hidden');
}

export function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
}

export function initModals() {
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });

  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.modal-overlay')?.classList.add('hidden');
    });
  });
}
