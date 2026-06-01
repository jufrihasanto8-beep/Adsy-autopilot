// api/create-user.js — Buat user baru (admin only)
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, password, role } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email dan password wajib diisi' });
  }

  try {
    // Create auth user using service key
    const { data: authData, error: authError } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });

    if (authError) throw authError;

    // Create profile
    const { error: profileError } = await sb.from('profiles').insert({
      id: authData.user.id,
      name: name || email.split('@')[0],
      email,
      role: role || 'advertiser'
    });

    if (profileError) throw profileError;

    return res.status(200).json({ success: true, user: authData.user });
  } catch (err) {
    console.error('create-user error:', err);
    return res.status(500).json({ error: err.message });
  }
}
