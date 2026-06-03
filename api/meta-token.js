// api/meta-token.js — Convert short-lived Meta token ke long-lived (60 hari)
// App ID, App Secret, dan token diambil dari Supabase milik advertiser masing-masing
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id diperlukan' });

  // Ambil semua credentials dari Supabase
  const { data: cfg } = await sb.from('app_config')
    .select('meta_token, meta_app_id, meta_app_secret')
    .eq('user_id', user_id)
    .single();

  if (!cfg?.meta_token)     return res.status(400).json({ error: 'Token belum disimpan di Pengaturan' });
  if (!cfg?.meta_app_id)    return res.status(400).json({ error: 'App ID belum diisi di Pengaturan' });
  if (!cfg?.meta_app_secret) return res.status(400).json({ error: 'App Secret belum diisi di Pengaturan' });

  try {
    const url = `https://graph.facebook.com/v18.0/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${encodeURIComponent(cfg.meta_app_id)}` +
      `&client_secret=${encodeURIComponent(cfg.meta_app_secret)}` +
      `&fb_exchange_token=${encodeURIComponent(cfg.meta_token)}`;

    const metaRes  = await fetch(url);
    const metaData = await metaRes.json();

    if (metaData.error) {
      const e = metaData.error;
      throw new Error(`${e.error_user_msg || e.message} (code: ${e.code})`);
    }

    const longLivedToken = metaData.access_token;
    const expiresIn      = metaData.expires_in; // ~5183944 detik (~60 hari)

    // Simpan long-lived token ke Supabase
    await sb.from('app_config').update({ meta_token: longLivedToken })
      .eq('user_id', user_id);

    return res.status(200).json({
      success: true,
      access_token: longLivedToken,
      expires_in: expiresIn
    });

  } catch (err) {
    console.error('meta-token exchange error:', err);
    return res.status(500).json({ error: err.message });
  }
}
