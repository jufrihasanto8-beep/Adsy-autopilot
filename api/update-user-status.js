// api/update-user-status.js — Update status/role user (admin only, pakai service key)
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, status, role } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId wajib diisi' });

  const updates = {};
  if (status !== undefined) updates.status = status;
  if (role !== undefined) updates.role = role;

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Tidak ada yang diupdate' });

  const { error } = await sb.from('profiles').update(updates).eq('id', userId);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ success: true });
}
