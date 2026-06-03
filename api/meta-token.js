// api/meta-token.js — Convert short-lived Meta token ke long-lived (60 hari)
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, user_id } = req.body;
  if (!token) return res.status(400).json({ error: 'Token diperlukan' });

  const appId     = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  if (!appId || !appSecret) {
    return res.status(500).json({ error: 'META_APP_ID dan META_APP_SECRET belum diset di environment variables' });
  }

  try {
    const url = `https://graph.facebook.com/v18.0/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${encodeURIComponent(appId)}` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&fb_exchange_token=${encodeURIComponent(token)}`;

    const metaRes  = await fetch(url);
    const metaData = await metaRes.json();

    if (metaData.error) {
      const e = metaData.error;
      throw new Error(`${e.error_user_msg || e.message} (code: ${e.code})`);
    }

    const longLivedToken = metaData.access_token;
    const expiresIn      = metaData.expires_in; // seconds, ~5183944 (~60 hari)

    // Auto-save ke Supabase jika ada user_id
    if (user_id && longLivedToken) {
      try {
        await sb.from('app_config').upsert(
          { user_id, meta_token: longLivedToken },
          { onConflict: 'user_id' }
        );
      } catch (dbErr) {
        console.error('auto-save token failed (non-fatal):', dbErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      access_token: longLivedToken,
      expires_in: expiresIn,
      token_type: metaData.token_type || 'bearer'
    });

  } catch (err) {
    console.error('meta-token exchange error:', err);
    return res.status(500).json({ error: err.message });
  }
}
