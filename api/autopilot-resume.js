// api/autopilot-resume.js — Hidupkan ulang kampanye Phase 1 yang di-pause
// Dijalankan setiap hari jam 3 pagi WIB via cron-job.org

import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const META_API = 'https://graph.facebook.com/v18.0';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Security: cek secret key
  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET) {
    const headerSecret = req.headers['x-cron-secret'];
    const querySecret  = req.query?.secret;
    if (headerSecret !== CRON_SECRET && querySecret !== CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  let resumed = 0;
  const logs = [];

  try {
    // Ambil semua kampanye Phase 1 & 2 yang sedang pause + autopilot aktif
    const { data: campaigns } = await sb.from('campaigns')
      .select('*')
      .eq('status', 'PAUSED')
      .in('current_phase', [1, 2])
      .eq('autopilot_enabled', true);

    if (!campaigns?.length) {
      return res.status(200).json({ success: true, resumed: 0, message: 'Tidak ada kampanye Phase 1 yang perlu dihidupkan' });
    }

    for (const camp of campaigns) {
      try {
        const { data: config } = await sb.from('app_config')
          .select('meta_token').eq('user_id', camp.user_id).single();
        const token = config?.meta_token || process.env.META_ACCESS_TOKEN;

        // Reset budget ke initial kalau Phase 1 winning (initial_budget tersimpan)
        const resetBudget = camp.current_phase === 1 && camp.initial_budget ? camp.initial_budget : null;

        // Hidupkan di Meta
        if (camp.meta_campaign_id && token) {
          await fetch(`${META_API}/${camp.meta_campaign_id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'ACTIVE', access_token: token })
          });
        }

        // Reset budget di adset kalau perlu
        if (resetBudget && camp.meta_adset_id && token) {
          await fetch(`${META_API}/${camp.meta_adset_id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ daily_budget: resetBudget, access_token: token })
          });
        }

        // Update status + reset budget di Supabase
        await sb.from('campaigns').update({
          status: 'ACTIVE',
          last_results: 0,
          ...(resetBudget ? { daily_budget: resetBudget } : {})
        }).eq('id', camp.id);

        const logEntry = {
          user_id: camp.user_id,
          campaign_name: camp.name,
          action_type: 'resume',
          description: `"${camp.name}" dihidupkan kembali jam 3 pagi — Phase ${camp.current_phase} hari ke-${camp.days_running}${resetBudget ? `, budget reset ke Rp ${resetBudget.toLocaleString('id-ID')}` : ''}`,
          status: 'success'
        };
        await sb.from('action_logs').insert(logEntry);
        logs.push(logEntry);
        resumed++;

      } catch (err) {
        console.error(`Error resuming campaign ${camp.name}:`, err.message);
      }
    }

    return res.status(200).json({ success: true, resumed, logs });

  } catch (err) {
    console.error('autopilot-resume error:', err);
    return res.status(500).json({ error: err.message });
  }
}
