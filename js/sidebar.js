import { logout } from './auth.js';
import { getSupabase } from './supabase.js';

// ── SIDEBAR ACTIVE STATE ──
export function initSidebar() {
  const current = window.location.pathname.split('/').pop() || 'dashboard.html';

  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    if (item.dataset.page === current) item.classList.add('active');
    item.addEventListener('click', () => { window.location.href = item.dataset.page; });
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

  injectProfileModal();
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

    // Update sidebar langsung
    const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || '?';
    document.getElementById('sidebar-user-name').textContent = name;
    const avatarEl = document.getElementById('sidebar-avatar');
    if (avatarUrl) {
      avatarEl.innerHTML = `<img src="${avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`;
    } else {
      avatarEl.textContent = initials;
    }

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
