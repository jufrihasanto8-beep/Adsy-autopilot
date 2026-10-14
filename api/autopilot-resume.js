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
        // Cek apakah di-pause oleh autopilot (ada action_log) vs user manual (tidak ada log)
        // Kalau user yang pause manual, jangan resume otomatis jam 3 pagi
        const { data: autopilotLog } = await sb.from('action_logs')
          .select('id').eq('user_id', camp.user_id).eq('campaign_name', camp.name)
          .eq('action_type', 'pause')
          .gte('created_at', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
          .limit(1).maybeSingle();
        if (!autopilotLog) continue; // User yang pause manual, skip

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

    // ── Auto-expire: hapus request pending yang tidak direview >1 hari ──
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Ambil dulu untuk reverse saldo jika ada spend yang terecord
      const { data: expiredReqs } = await sb.from('topup_requests')
        .select('id, topup_ad_account_id')
        .eq('status', 'pending')
        .lt('created_at', oneDayAgo);

      if (expiredReqs?.length) {
        for (const req of expiredReqs) {
          // Reverse saldo jika ada log spend
          if (req.topup_ad_account_id) {
            const { data: spendLog } = await sb.from('topup_ad_account_logs')
              .select('amount')
              .eq('request_id', req.id)
              .eq('type', 'spend')
              .maybeSingle();

            if (spendLog?.amount > 0) {
              const { data: acct } = await sb.from('topup_ad_accounts')
                .select('saldo_saat_ini').eq('id', req.topup_ad_account_id).single();
              const newSaldo = Math.max(0, (Number(acct?.saldo_saat_ini) || 0) - spendLog.amount);
              await sb.from('topup_ad_accounts')
                .update({ saldo_saat_ini: newSaldo, updated_at: new Date().toISOString() })
                .eq('id', req.topup_ad_account_id);
              await sb.from('topup_ad_account_logs').insert({
                ad_account_id: req.topup_ad_account_id,
                type: 'spend_reversed',
                amount: -spendLog.amount,
                request_id: req.id,
                catatan: 'Auto-expire — tidak direview >1 hari',
                tanggal: new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
              });
            }
          }
        }

        // Hapus semua request expired
        await sb.from('topup_requests')
          .delete()
          .eq('status', 'pending')
          .lt('created_at', oneDayAgo);
      }
    } catch (expireErr) {
      console.error('topup expire cleanup error:', expireErr.message);
    }

    // ── Cleanup topup-ss storage: hapus SS yang sudah direview atau >1 hari ──
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: oldReqs } = await sb.from('topup_requests')
        .select('ss_url')
        .not('ss_url', 'is', null)
        .or(`status.neq.pending,created_at.lt.${oneDayAgo}`);

      if (oldReqs?.length) {
        const paths = oldReqs
          .map(r => {
            try { return decodeURIComponent(new URL(r.ss_url).pathname.split('/topup-ss/')[1]); }
            catch { return null; }
          })
          .filter(Boolean);

        if (paths.length) {
          await sb.storage.from('topup-ss').remove(paths);
          // Kosongkan ss_url di DB agar tidak coba hapus lagi
          await sb.from('topup_requests')
            .update({ ss_url: null })
            .in('ss_url', oldReqs.map(r => r.ss_url));
        }
      }
    } catch (cleanErr) {
      console.error('topup-ss cleanup error:', cleanErr.message);
      // Tidak block return utama
    }

    return res.status(200).json({ success: true, resumed, logs });

  } catch (err) {
    console.error('autopilot-resume error:', err);
    return res.status(500).json({ error: err.message });
  }
}
