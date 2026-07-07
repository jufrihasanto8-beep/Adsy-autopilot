// api/create-user.js — Buat & kelola user (admin only)
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, name, email, password, role, userId, status } = req.body;

  // ── HAPUS USER ──
  if (action === 'delete') {
    if (!userId) return res.status(400).json({ error: 'userId wajib diisi' });
    try {
      // Hapus profiles dulu (FK ke auth.users), baru hapus auth user
      const { error: profileErr } = await sb.from('profiles').delete().eq('id', userId);
      if (profileErr) return res.status(500).json({ error: 'Gagal hapus profile: ' + profileErr.message });

      const { error: authErr } = await sb.auth.admin.deleteUser(userId);
      if (authErr) return res.status(500).json({ error: 'Gagal hapus auth user: ' + authErr.message });

      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── UPDATE STATUS / ROLE ──
  if (action === 'update' || action === 'update-status') {
    if (!userId) return res.status(400).json({ error: 'userId wajib diisi' });
    const updates = {};
    if (status !== undefined) updates.status = status;
    if (role !== undefined) updates.role = role;
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Tidak ada yang diupdate' });
    const { error } = await sb.from('profiles').update(updates).eq('id', userId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  // ── BUAT USER BARU ──
  if (!email || !password) {
    return res.status(400).json({ error: 'Email dan password wajib diisi' });
  }

  try {
    const { data: authData, error: authError } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });
    if (authError) throw authError;

    const { error: profileError } = await sb.from('profiles').insert({
      id: authData.user.id,
      name: name || email.split('@')[0],
      email,
      role: role || 'advertiser',
      status: 'active'
    });
    if (profileError) throw profileError;

    return res.status(200).json({ success: true, user: authData.user });
  } catch (err) {
    console.error('create-user error:', err);
    return res.status(500).json({ error: err.message });
  }
}
