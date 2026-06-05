// api/autopilot-run.js — Engine autopilot berbasis DIMENSI Ads Blueprint 2026
// Phase 1 (Testing) → Phase 2 (Evaluasi) → Phase 3 (Scale)
// Gate: 8.000 impressions sebelum ambil keputusan apapun
// Scale: 3%/hari, max +30%/hari, sesuai CPR vs target produk

import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const META_API = 'https://graph.facebook.com/v18.0';
const IMPRESSIONS_GATE = 8000;
const SCALE_PCT = 3;       // % naik/turun per hari
const MAX_SCALE_PCT = 30;  // batas maksimal kenaikan per hari

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Security: cek secret key (dari cron-job.org header atau query param)
  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET) {
    const headerSecret = req.headers['x-cron-secret'];
    const querySecret  = req.query?.secret;
    if (headerSecret !== CRON_SECRET && querySecret !== CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  let actionsTaken = 0;
  const logs = [];

  try {
    // Ambil semua kampanye aktif dengan autopilot, join ke products untuk target CPR
    const { data: campaigns } = await sb.from('campaigns')
      .select('*, products(target_cpr, target_roas)')
      .eq('status', 'ACTIVE')
      .eq('autopilot_enabled', true);

    if (!campaigns?.length) {
      return res.status(200).json({ success: true, actions_taken: 0, message: 'Tidak ada kampanye autopilot aktif' });
    }

    for (const camp of campaigns) {
      try {
        const { data: config } = await sb.from('app_config')
          .select('meta_token').eq('user_id', camp.user_id).single();
        const token = config?.meta_token || process.env.META_ACCESS_TOKEN;

        // Sync performa terbaru dari Meta sebelum evaluasi
        await syncCampaignInsights(camp, token);

        // Re-fetch kampanye setelah sync untuk data terbaru
        const { data: fresh } = await sb.from('campaigns')
          .select('*, products(target_cpr, target_roas)')
          .eq('id', camp.id).single();
        if (!fresh) continue;

        const targetCpr  = fresh.products?.target_cpr || null;
        const targetRoas = fresh.products?.target_roas || null;
        const impressions = fresh.impressions || 0;
        const daysRunning = fresh.days_running || 0;

        // ── Increment hari berjalan ──
        await sb.from('campaigns').update({ days_running: daysRunning + 1 }).eq('id', fresh.id);

        // ── GATE: Jangan ambil keputusan sebelum 8.000 impressions ──
        if (impressions < IMPRESSIONS_GATE) {
          logs.push({
            campaign_name: fresh.name,
            action_type: 'gate',
            description: `"${fresh.name}" — gate belum tercapai (${impressions.toLocaleString('id-ID')} / ${IMPRESSIONS_GATE.toLocaleString('id-ID')} impressions)`,
            status: 'skipped'
          });
          continue;
        }

        // ── Phase Advancement ──
        await checkPhaseAdvancement(fresh, targetCpr, daysRunning, logs);

        // Re-fetch lagi setelah phase advance
        const { data: latest } = await sb.from('campaigns')
          .select('*, products(target_cpr, target_roas)')
          .eq('id', fresh.id).single();
        if (!latest) continue;

        // ── Blueprint Rules (per phase) ──
        const acted = await runBlueprintRules(latest, targetCpr, targetRoas, token, logs);
        if (acted) actionsTaken++;

        // ── User-defined custom rules ──
        const { data: rules } = await sb.from('autopilot_rules')
          .select('*').eq('user_id', latest.user_id).eq('is_active', true);

        for (const rule of (rules || [])) {
          if (!matchesScope(rule.scope, latest.current_phase)) continue;
          const metricValue = getMetricValue(latest, rule.metric);
          if (evaluateCondition(metricValue, rule.operator, rule.value)) {
            await executeAction(latest, rule, token, latest.user_id, logs);
            actionsTaken++;
          }
        }

      } catch (campErr) {
        console.error(`Error processing campaign ${camp.name}:`, campErr.message);
      }
    }

    if (actionsTaken > 0) await sendWASummary(actionsTaken, logs);

    return res.status(200).json({ success: true, actions_taken: actionsTaken, logs });

  } catch (err) {
    console.error('autopilot-run error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Sync insights dari Meta (impressions, CPR, CTR, spend) ──
async function syncCampaignInsights(camp, token) {
  if (!camp.meta_campaign_id || !token) return;
  try {
    const fields = 'impressions,spend,clicks,ctr,actions';
    const res = await fetch(
      `${META_API}/${camp.meta_campaign_id}/insights?fields=${fields}&date_preset=today&access_token=${encodeURIComponent(token)}`
    );
    const data = await res.json();
    const insight = data?.data?.[0];
    if (!insight) return;

    const impressions = parseInt(insight.impressions || 0);
    const spend       = parseFloat(insight.spend || 0) * 1000; // Meta dalam USD → approx IDR
    const ctr         = parseFloat(insight.ctr || 0);

    // CPR = spend / results (sama persis dengan Ads Manager)
    const actions = insight.actions || [];
    const resultAction = actions.find(x =>
      x.action_type === 'offsite_conversion.fb_pixel_purchase' ||
      x.action_type === 'lead' ||
      x.action_type === 'post_engagement'
    );
    const results = parseInt(resultAction?.value || 0);
    const cpr = results > 0 ? Math.round(spend / results) : null;

    await sb.from('campaigns').update({
      impressions,
      spend_today: spend,
      ctr,
      ...(cpr !== null ? { cpr } : {})
    }).eq('id', camp.id);

  } catch (err) {
    console.error('syncInsights error:', err.message);
  }
}

// ── Phase Advancement sesuai DIMENSI blueprint ──
async function checkPhaseAdvancement(camp, targetCpr, daysRunning, logs) {
  let newPhase = camp.current_phase;
  const cpr = camp.cpr;

  // Phase 1 → 2: gate 8k impressions + min 3 hari + seleksi CPR
  if (camp.current_phase === 1 && daysRunning >= 3 && camp.impressions >= 8000) {
    if (!targetCpr) {
      // Tidak ada target CPR → langsung maju
      newPhase = 2;
    } else if (cpr !== null && cpr <= targetCpr) {
      // CPR ≤ target → langsung maju Phase 2
      newPhase = 2;
    } else if (cpr !== null && cpr <= targetCpr * 1.1) {
      // CPR antara target s/d +10% → dapat 1 hari tambahan
      if (daysRunning >= 4) {
        newPhase = 2; // Sudah dapat kesempatan 1 hari, maju
      } else {
        // Masih hari ke-3, tunggu 1 hari lagi
        const logEntry = {
          user_id: camp.user_id,
          campaign_name: camp.name,
          action_type: 'phase_hold',
          description: `"${camp.name}" dapat 1 hari tambahan — CPR Rp ${Math.round(cpr).toLocaleString('id-ID')} (dalam batas +10% dari target)`,
          status: 'info'
        };
        await sb.from('action_logs').insert(logEntry);
        logs.push(logEntry);
      }
    } else if (cpr !== null && cpr > targetCpr * 1.1) {
      // CPR terlalu jelek setelah 3 hari → pause permanen
      await sb.from('campaigns').update({
        status: 'PAUSED',
        autopilot_enabled: false
      }).eq('id', camp.id);
      const logEntry = {
        user_id: camp.user_id,
        campaign_name: camp.name,
        action_type: 'pause',
        description: `"${camp.name}" dihentikan permanen — CPR Rp ${Math.round(cpr).toLocaleString('id-ID')} masih > 10% dari target setelah ${daysRunning} hari`,
        status: 'success'
      };
      await sb.from('action_logs').insert(logEntry);
      logs.push(logEntry);
      return;
    }
  }

  // Phase 2 → 3: 7 hari + CPR ≤ target (baseline sudah ada, siap scale)
  if (camp.current_phase === 2 && daysRunning >= 7) {
    const cprOk = !targetCpr || (cpr && cpr <= targetCpr);
    if (cprOk) newPhase = 3;
  }

  if (newPhase !== camp.current_phase) {
    await sb.from('campaigns').update({
      current_phase: newPhase,
      phase_started_at: new Date().toISOString()
    }).eq('id', camp.id);

    const label = { 2: 'Evaluasi', 3: 'Scale' };
    const logEntry = {
      user_id: camp.user_id,
      campaign_name: camp.name,
      action_type: 'phase_advance',
      description: `"${camp.name}" maju ke Phase ${newPhase} — ${label[newPhase]}`,
      status: 'success'
    };
    await sb.from('action_logs').insert(logEntry);
    logs.push(logEntry);
  }
}

// ── Blueprint Rules utama ──
async function runBlueprintRules(camp, targetCpr, targetRoas, token, logs) {
  if (!targetCpr) return false; // Tidak ada target = skip blueprint rules

  const cpr         = camp.cpr;
  const budget      = camp.daily_budget || 50000;
  const currentPhase = camp.current_phase;
  const today       = new Date().toISOString().slice(0, 10);

  // Cegah multiple budget change dalam satu hari
  if (camp.last_budget_change_date === today) return false;

  // Phase 1: Testing — pause kalau CPR > 2.5x target
  if (currentPhase === 1 && cpr !== null && cpr !== undefined) {
    if (cpr > targetCpr * 2.5) {
      await pauseCampaign(camp, token);
      const logEntry = {
        user_id: camp.user_id,
        campaign_name: camp.name,
        action_type: 'pause',
        description: `"${camp.name}" di-pause di Phase 1 — CPR Rp ${Math.round(cpr).toLocaleString('id-ID')} (${Math.round(cpr/targetCpr*100)}% dari target, > 2.5× target)`,
        status: 'success'
      };
      await sb.from('action_logs').insert(logEntry);
      logs.push(logEntry);
      return true;
    }
  }

  // Phase 3: Scale mode — naik/turun budget 3%/hari
  if (currentPhase === 3 && cpr !== null && cpr !== undefined) {

    // CPR > 2x target → pause otomatis
    if (cpr > targetCpr * 2) {
      await pauseCampaign(camp, token);
      const logEntry = {
        user_id: camp.user_id,
        campaign_name: camp.name,
        action_type: 'pause',
        description: `"${camp.name}" di-pause otomatis — CPR Rp ${Math.round(cpr).toLocaleString('id-ID')} (${Math.round(cpr/targetCpr*100)}% dari target)`,
        status: 'success'
      };
      await sb.from('action_logs').insert(logEntry);
      logs.push(logEntry);
      return true;
    }

    // CPR ≤ target → naik budget 3% (max 30%)
    if (cpr <= targetCpr) {
      const scalePct  = Math.min(SCALE_PCT, MAX_SCALE_PCT);
      const newBudget = Math.floor(budget * (1 + scalePct / 100));
      await updateBudget(camp, newBudget, token);
      const logEntry = {
        user_id: camp.user_id,
        campaign_name: camp.name,
        action_type: 'increase_budget',
        description: `"${camp.name}" budget naik ${scalePct}% → Rp ${newBudget.toLocaleString('id-ID')} (CPR Rp ${Math.round(cpr).toLocaleString('id-ID')} ≤ target)`,
        status: 'success'
      };
      await sb.from('action_logs').insert(logEntry);
      logs.push(logEntry);
      return true;
    }

    // CPR > target (tapi < 2x) → turun budget 3%
    if (cpr > targetCpr) {
      const newBudget = Math.max(Math.floor(budget * (1 - SCALE_PCT / 100)), 10000);
      await updateBudget(camp, newBudget, token);
      const logEntry = {
        user_id: camp.user_id,
        campaign_name: camp.name,
        action_type: 'decrease_budget',
        description: `"${camp.name}" budget turun ${SCALE_PCT}% → Rp ${newBudget.toLocaleString('id-ID')} (CPR Rp ${Math.round(cpr).toLocaleString('id-ID')} > target)`,
        status: 'success'
      };
      await sb.from('action_logs').insert(logEntry);
      logs.push(logEntry);
      return true;
    }
  }

  // Phase 2: Evaluasi — pause kalau CPR jauh di atas target
  if (currentPhase === 2 && cpr !== null && cpr > targetCpr * 1.5) {
    await pauseCampaign(camp, token);
    const logEntry = {
      user_id: camp.user_id,
      campaign_name: camp.name,
      action_type: 'pause',
      description: `"${camp.name}" di-pause di Phase 2 — CPR Rp ${Math.round(cpr).toLocaleString('id-ID')} (${Math.round(cpr/targetCpr*100)}% dari target, terlalu mahal)`,
      status: 'success'
    };
    await sb.from('action_logs').insert(logEntry);
    logs.push(logEntry);
    return true;
  }

  return false;
}

// ── Helpers ──
async function pauseCampaign(camp, token) {
  if (camp.meta_campaign_id && token) {
    await fetch(`${META_API}/${camp.meta_campaign_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'PAUSED', access_token: token })
    });
  }
  await sb.from('campaigns').update({ status: 'PAUSED' }).eq('id', camp.id);
}

async function updateBudget(camp, newBudget, token) {
  if (camp.meta_adset_id && token) {
    await fetch(`${META_API}/${camp.meta_adset_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daily_budget: newBudget, access_token: token })
    });
  }
  await sb.from('campaigns').update({
    daily_budget: newBudget,
    last_budget_change_date: new Date().toISOString().slice(0, 10)
  }).eq('id', camp.id);
}

// ── Custom rules engine (user-defined) ──
function getMetricValue(camp, metric) {
  return { cpr: camp.cpr, ctr: camp.ctr, roas: camp.roas, spend: camp.spend_today, days: camp.days_running }[metric];
}

function evaluateCondition(value, operator, threshold) {
  if (value === null || value === undefined) return false;
  const v = parseFloat(value), t = parseFloat(threshold);
  return { gt: v > t, lt: v < t, gte: v >= t, lte: v <= t }[operator] ?? false;
}

function matchesScope(scope, currentPhase) {
  if (!scope || scope === 'all') return true;
  return scope === `phase${currentPhase}`;
}

async function executeAction(camp, rule, token, userId, logs) {
  const logEntry = { campaign_id: camp.id, campaign_name: camp.name, user_id: userId, action_type: rule.action_type, status: 'success' };
  try {
    switch (rule.action_type) {
      case 'pause':
        await pauseCampaign(camp, token);
        logEntry.description = `"${camp.name}" di-pause — Rule: ${rule.name}`;
        break;
      case 'resume':
        if (camp.meta_campaign_id && token) {
          await fetch(`${META_API}/${camp.meta_campaign_id}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'ACTIVE', access_token: token })
          });
        }
        await sb.from('campaigns').update({ status: 'ACTIVE' }).eq('id', camp.id);
        logEntry.description = `"${camp.name}" diaktifkan — Rule: ${rule.name}`;
        break;
      case 'increase_budget': {
        const pct = Math.min(parseFloat(rule.action_value) || 20, MAX_SCALE_PCT);
        const nb  = Math.floor(camp.daily_budget * (1 + pct / 100));
        await updateBudget(camp, nb, token);
        logEntry.description = `Budget "${camp.name}" naik ${pct}% → Rp ${nb.toLocaleString('id-ID')} — Rule: ${rule.name}`;
        break;
      }
      case 'decrease_budget': {
        const pct = parseFloat(rule.action_value) || 20;
        const nb  = Math.max(Math.floor(camp.daily_budget * (1 - pct / 100)), 10000);
        await updateBudget(camp, nb, token);
        logEntry.description = `Budget "${camp.name}" turun ${pct}% — Rule: ${rule.name}`;
        break;
      }
      case 'notify':
        logEntry.description = `Notifikasi untuk "${camp.name}" — Rule: ${rule.name}`;
        break;
    }
    await sb.from('action_logs').insert(logEntry);
    logs.push(logEntry);
  } catch (err) {
    logEntry.status = 'error';
    logEntry.description = err.message;
    await sb.from('action_logs').insert(logEntry).catch(() => {});
  }
}

async function sendWASummary(count, logs) {
  try {
    const { data: configs } = await sb.from('app_config')
      .select('fonnte_token, wa_target').not('fonnte_token', 'is', null);
    for (const config of (configs || [])) {
      if (!config.fonnte_token || !config.wa_target) continue;
      const summary = logs.filter(l => l.status !== 'skipped').slice(0, 5)
        .map(l => `• ${l.description}`).join('\n');
      const message = `🤖 *Adsy Autopilot*\n\n${count} aksi dijalankan:\n${summary}\n\nCek dashboard untuk detail lengkap.`;
      await fetch('https://api.fonnte.com/send', {
        method: 'POST',
        headers: { 'Authorization': config.fonnte_token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: config.wa_target, message })
      });
    }
  } catch (err) {
    console.error('WA summary error:', err.message);
  }
}
