import { getSupabase } from './supabase.js';

// ── SESSION CHECK ──
export async function requireAuth() {
  const sb = await getSupabase();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    window.location.href = '/index.html';
    return null;
  }
  return session;
}

// ── GET CURRENT USER PROFILE ──
export async function getProfile() {
  const sb = await getSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;

  const { data } = await sb.from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  return data;
}

// ── RENDER USER INFO ──
export async function renderUserInfo() {
  const profile = await getProfile();
  if (!profile) return;

  const nameEl = document.getElementById('user-name');
  const emailEl = document.getElementById('user-email');
  const avatarEl = document.getElementById('user-avatar');
  const sidebarNameEl = document.getElementById('sidebar-user-name');
  const sidebarRoleEl = document.getElementById('sidebar-user-role');
  const sidebarAvatarEl = document.getElementById('sidebar-avatar');

  const initials = profile.name
    ? profile.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : '??';

  if (nameEl) nameEl.textContent = profile.name || 'User';
  if (emailEl) emailEl.textContent = profile.email || '';
  if (avatarEl) {
    if (profile.avatar_url) {
      avatarEl.innerHTML = `<img src="${profile.avatar_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`;
    } else {
      avatarEl.textContent = initials;
    }
  }
  if (sidebarNameEl) sidebarNameEl.textContent = profile.name || 'User';
  if (sidebarRoleEl) sidebarRoleEl.textContent = profile.role === 'admin' ? 'Admin' : 'Advertiser';
  if (sidebarAvatarEl) {
    if (profile.avatar_url) {
      sidebarAvatarEl.innerHTML = `<img src="${profile.avatar_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`;
    } else {
      sidebarAvatarEl.textContent = initials;
    }
  }

  if (['admin', 'superadmin'].includes(profile.role)) {
    document.querySelectorAll('[data-admin-only]').forEach(el => el.style.display = '');
  }

  return profile;
}

// ── LOGIN ──
export async function login(email, password) {
  const sb = await getSupabase();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

// ── LOGOUT ──
export async function logout() {
  const sb = await getSupabase();
  await sb.auth.signOut();
  window.location.href = '/index.html';
}

// ── GUARD: ADMIN ONLY ──
export async function requireAdmin() {
  const profile = await getProfile();
  if (!profile || profile.role !== 'admin') {
    window.location.href = '/dashboard.html';
    return null;
  }
  return profile;
}
