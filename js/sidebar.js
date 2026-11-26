import { logout } from './auth.js';
import { getSupabase } from './supabase.js';
import { initChatWidget } from './chat-widget.js';

// ── SIDEBAR COLLAPSE ──
function initSidebarCollapse() {
  const logo = document.querySelector('.sidebar-logo');
  if (!logo) return;

  // Inject collapse/expand toggle button inside logo area
  if (!document.getElementById('sidebar-collapse-btn')) {
    const btn = document.createElement('button');
    btn.id = 'sidebar-collapse-btn';
    btn.className = 'sidebar-collapse-btn';
    btn.addEventListener('click', toggleSidebarCollapse);
    logo.appendChild(btn);
  }

  // Add data-label to nav items for tooltip
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    if (!item.dataset.label) {
      const clone = item.cloneNode(true);
      clone.querySelectorAll('.nav-icon, .nav-badge').forEach(el => el.remove());
      item.dataset.label = clone.textContent.trim();
    }
  });

  // Restore saved state
  const collapsed = localStorage.getItem('sidebar_collapsed') === 'true';
  if (collapsed) document.body.classList.add('sidebar-collapsed');
  _updateCollapseBtn(collapsed);
}

function _updateCollapseBtn(isCollapsed) {
  const btn = document.getElementById('sidebar-collapse-btn');
  if (!btn) return;
  btn.innerHTML = isCollapsed ? '›' : '‹';
  btn.title = isCollapsed ? 'Tampilkan sidebar' : 'Sembunyikan sidebar';
}

function toggleSidebarCollapse() {
  const isCollapsed = document.body.classList.toggle('sidebar-collapsed');
  localStorage.setItem('sidebar_collapsed', isCollapsed);
  _updateCollapseBtn(isCollapsed);
  // Re-apply data-label to newly injected nav items
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    if (!item.dataset.label) {
      const clone = item.cloneNode(true);
      clone.querySelectorAll('.nav-icon, .nav-badge').forEach(el => el.remove());
      item.dataset.label = clone.textContent.trim();
    }
  });
}

// ── COLLAPSED TOOLTIP (JS, appended to body so never clipped) ──
let _tip = null;
function _showTip(e) {
  if (!document.body.classList.contains('sidebar-collapsed')) return;
  const label = e.currentTarget.dataset.label;
  if (!label) return;
  if (!_tip) {
    _tip = document.createElement('div');
    Object.assign(_tip.style, {
      position:'fixed', background:'#1a2b3c', color:'#fff', fontSize:'12px',
      fontWeight:'500', padding:'6px 10px', borderRadius:'7px', whiteSpace:'nowrap',
      pointerEvents:'none', zIndex:'9999', boxShadow:'0 4px 12px rgba(0,0,0,0.15)',
      transition:'opacity 0.12s', fontFamily:'DM Sans, Inter, sans-serif'
    });
    document.body.appendChild(_tip);
  }
  _tip.textContent = label;
  const rect = e.currentTarget.getBoundingClientRect();
  _tip.style.left = (rect.right + 10) + 'px';
  _tip.style.top = (rect.top + rect.height / 2) + 'px';
  _tip.style.transform = 'translateY(-50%)';
  _tip.style.opacity = '1';
  _tip.style.display = 'block';
}
function _hideTip() {
  if (_tip) { _tip.style.opacity = '0'; _tip.style.display = 'none'; }
}
function _initTooltips() {
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('mouseenter', _showTip);
    item.addEventListener('mouseleave', _hideTip);
  });
}

// ── MOBILE MENU HELPERS ──
function openMobileMenu() {
  document.querySelector('.sidebar')?.classList.add('open');
  document.getElementById('sidebar-overlay')?.classList.add('visible');
  document.body.style.overflow = 'hidden';
}

function closeMobileMenu() {
  document.querySelector('.sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('visible');
  document.body.style.overflow = '';
}

// ── SIDEBAR ACTIVE STATE ──
export function initSidebar() {
  const current = window.location.pathname.split('/').pop() || 'dashboard.html';

  // Inject hamburger button ke topbar
  const topbar = document.querySelector('.topbar');
  if (topbar && !document.getElementById('mob-menu-btn')) {
    const btn = document.createElement('button');
    btn.id = 'mob-menu-btn';
    btn.className = 'mob-menu-btn';
    btn.innerHTML = '☰';
    btn.addEventListener('click', openMobileMenu);
    topbar.insertBefore(btn, topbar.firstChild);
  }

  // Inject overlay
  if (!document.getElementById('sidebar-overlay')) {
    const overlay = document.createElement('div');
    overlay.id = 'sidebar-overlay';
    overlay.className = 'sidebar-overlay';
    overlay.addEventListener('click', closeMobileMenu);
    document.body.appendChild(overlay);
  }

  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    if (item.dataset.page === current) item.classList.add('active');
    // Auto-set data-label for collapsed tooltip from text content
    if (!item.dataset.label) {
      const txt = item.textContent.trim();
      if (txt) item.dataset.label = txt;
    }
    item.addEventListener('click', () => {
      closeMobileMenu();
      window.location.href = item.dataset.page;
    });
  });

  // ⏏ tombol logout (hanya icon eject)
  const logoutIcon = document.querySelector('.sidebar-user-more');
  if (logoutIcon) {
    logoutIcon.style.cursor = 'pointer';
    logoutIcon.addEventListener('click', e => { e.stopPropagation(); logout(); });
  }

  // Klik avatar/nama → buka modal profil
  const userArea = document.getElementById('btn-logout');
  if (userArea) {
    userArea.style.cursor = 'pointer';
    userArea.addEventListener('click', openProfileModal);
  }

  // Autopilot toggle
  const apToggle = document.getElementById('autopilot-toggle');
  if (apToggle) {
    const saved = localStorage.getItem('autopilot_active') === 'true';
    if (saved) apToggle.classList.add('on');

    const statusText = document.getElementById('autopilot-status-text');
    if (statusText) statusText.textContent = saved ? 'Berjalan aktif' : 'Tidak aktif';

    apToggle.addEventListener('click', () => {
      apToggle.classList.toggle('on');
      const isOn = apToggle.classList.contains('on');
      localStorage.setItem('autopilot_active', isOn);
      if (statusText) statusText.textContent = isOn ? 'Berjalan aktif' : 'Tidak aktif';
    });
  }

  _initTooltips();
  injectProfileModal();
  injectChatNavItem();
  injectLaporanNavItem();
  initSidebarCollapse();
  // Init floating chat bubble (async, tidak block render)
  initChatWidget().catch(() => {});
}

function injectChatNavItem() {
  const nav = document.querySelector('.sidebar-nav');
  if (!nav || nav.querySelector('[data-page="chat.html"]')) return;
  const item = document.createElement('div');
  item.className = 'nav-item';
  item.dataset.page = 'chat.html';
  item.innerHTML = '<span class="nav-icon">💬</span> Chat <span class="nav-badge" id="chat-nav-badge" style="display:none;background:#ef4444;">0</span>';
  // Click handler — harus di-set sendiri karena diinject setelah loop nav item
  item.addEventListener('click', () => {
    closeMobileMenu();
    window.location.href = 'chat.html';
  });
  // Insert setelah settings.html
  const settingsItem = nav.querySelector('[data-page="settings.html"]');
  if (settingsItem) settingsItem.insertAdjacentElement('afterend', item);
  else nav.appendChild(item);
  // Set active state
  const current = window.location.pathname.split('/').pop() || 'dashboard.html';
  if (current === 'chat.html') item.classList.add('active');
}


function injectLaporanNavItem() {
  const nav = document.querySelector('.sidebar-nav');
  if (!nav || nav.querySelector('[data-page="laporan.html"]')) return;
  const item = document.createElement('div');
  item.className = 'nav-item';
  item.dataset.page = 'laporan.html';
  item.innerHTML = '<span class="nav-icon">📊</span> Laporan Akuisisi';
  item.addEventListener('click', () => {
    closeMobileMenu();
    window.location.href = 'laporan.html';
  });
  const reportsItem = nav.querySelector('[data-page="reports.html"]');
  if (reportsItem) reportsItem.insertAdjacentElement('afterend', item);
  else nav.appendChild(item);
  const current = window.location.pathname.split('/').pop() || 'dashboard.html';
  if (current === 'laporan.html') item.classList.add('active');
}

// ── PROFILE MODAL ──
function injectProfileModal() {
  if (document.getElementById('modal-profile')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay hidden" id="modal-profile">
      <div class="modal" style="max-width:420px;">
        <div class="modal-header">
          <h3>Edit Profil</h3>
          <div class="modal-close" onclick="document.getElementById('modal-profile').classList.add('hidden')">✕</div>
        </div>
        <div class="modal-body">
          <div style="display:flex; flex-direction:column; align-items:center; gap:12px; margin-bottom:20px;">
            <div id="prof-avatar-preview" style="width:80px; height:80px; border-radius:50%; background:var(--primary); display:flex; align-items:center; justify-content:center; font-size:28px; font-weight:700; color:#fff; overflow:hidden; cursor:pointer;" onclick="document.getElementById('prof-photo-input').click()">
              <span id="prof-avatar-initials">?</span>
            </div>
            <input type="file" id="prof-photo-input" accept="image/*" style="display:none;" />
            <button class="btn btn-outline btn-sm" onclick="document.getElementById('prof-photo-input').click()">Ganti Foto</button>
            <div id="prof-photo-hint" style="font-size:11px; color:var(--gray-5);">Klik avatar atau tombol untuk upload foto</div>
          </div>
          <div class="form-group">
            <label class="form-label">Nama Tampilan</label>
            <input type="text" class="form-input" id="prof-name" placeholder="Nama kamu..." />
          </div>
          <div class="form-group">
            <label class="form-label">Email</label>
            <input type="text" class="form-input" id="prof-email" disabled style="background:var(--gray-1); color:var(--gray-5);" />
          </div>
          <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:8px;">
            <button class="btn btn-outline" onclick="document.getElementById('modal-profile').classList.add('hidden')">Batal</button>
            <button class="btn btn-primary" id="btn-save-profile">Simpan</button>
          </div>
        </div>
      </div>
    </div>
  `);

  document.getElementById('prof-photo-input').addEventListener('change', previewPhoto);
  document.getElementById('btn-save-profile').addEventListener('click', saveProfile);
}

let _profileData = null;

async function openProfileModal() {
  const sb = await getSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;

  const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).single();
  _profileData = profile;

  // Isi form
  document.getElementById('prof-name').value = profile?.name || '';
  document.getElementById('prof-email').value = user.email || '';

  // Set preview avatar
  const preview = document.getElementById('prof-avatar-preview');
  const initials = document.getElementById('prof-avatar-initials');
  if (profile?.avatar_url) {
    preview.innerHTML = `<img src="${profile.avatar_url}" style="width:100%;height:100%;object-fit:cover;" />`;
  } else {
    const letters = (profile?.name || user.email || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    preview.innerHTML = `<span id="prof-avatar-initials">${letters}</span>`;
  }

  document.getElementById('modal-profile').classList.remove('hidden');
}

function previewPhoto(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    document.getElementById('prof-avatar-preview').innerHTML =
      `<img src="${ev.target.result}" style="width:100%;height:100%;object-fit:cover;" />`;
    document.getElementById('prof-photo-hint').textContent = file.name;
  };
  reader.readAsDataURL(file);
}

async function saveProfile() {
  const btn = document.getElementById('btn-save-profile');
  btn.disabled = true; btn.textContent = 'Menyimpan...';

  try {
    const sb   = await getSupabase();
    const { data: { user } } = await sb.auth.getUser();
    const name = document.getElementById('prof-name').value.trim();
    const file = document.getElementById('prof-photo-input').files[0];

    let avatarUrl = _profileData?.avatar_url || null;

    // Upload foto jika ada
    if (file) {
      const ext  = file.name.split('.').pop();
      const path = `${user.id}/avatar.${ext}`;
      const { error: upErr } = await sb.storage.from('avatars').upload(path, file, { upsert: true });
      if (upErr) throw new Error('Gagal upload foto: ' + upErr.message);
      const { data: urlData } = sb.storage.from('avatars').getPublicUrl(path);
      avatarUrl = urlData.publicUrl + '?t=' + Date.now(); // cache bust
    }

    // Update profiles
    await sb.from('profiles').update({ name, avatar_url: avatarUrl }).eq('id', user.id);

    // Update semua avatar & nama di halaman langsung
    const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || '?';
    const avatarImg = avatarUrl
      ? `<img src="${avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
      : null;

    document.getElementById('sidebar-user-name').textContent = name;
    ['sidebar-avatar', 'user-avatar'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (avatarImg) el.innerHTML = avatarImg;
      else el.textContent = initials;
    });
    const nameEl = document.getElementById('user-name');
    if (nameEl) nameEl.textContent = name;

    showToast('Profil berhasil diperbarui!', 'success');
    document.getElementById('modal-profile').classList.add('hidden');

  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Simpan';
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
  return 'Rp ' + Math.round(Number(n)).toLocaleString('id-ID');
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
