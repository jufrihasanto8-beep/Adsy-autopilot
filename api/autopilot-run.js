// api/autopilot-run.js — Engine autopilot: cek rules & eksekusi aksi
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const META_API = 'https://graph.facebook.com/v18.0';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let actionsTaken = 0;
  const logs = [];

  try {
    // 1. Get all active campaigns with autopilot enabled
    const { data: campaigns } = await sb.from('campaigns')
      .select('*')
      .eq('status', 'ACTIVE')
      .eq('autopilot_enabled', true);

    if (!campaigns || campaigns.length === 0) {
      return res.status(200).json({ success: true, actions_taken: 0, message: 'Tidak ada kampanye autopilot aktif' });
    }

    for (const camp of campaigns) {
      // 2. Get user rules
      const { data: rules } = await sb.from('autopilot_rules')
        .select('*')
        .eq('user_id', camp.user_id)
        .eq('is_active', true);

      // 3. Get user scheme
      const { data: scheme } = await sb.from('autopilot_scheme')
        .select('*').eq('user_id', camp.user_id).single();

      // 4. Get user config
      const { data: config } = await sb.from('app_config')
        .select('meta_token, meta_account').eq('user_id', camp.user_id).single();

      const token = config?.meta_token || process.env.META_ACCESS_TOKEN;

      // 5. Check phase advancement
      await checkPhaseAdvancement(camp, scheme, token, logs);

      // 6. Check & execute rules
      for (const rule of (rules || [])) {
        const shouldApply = matchesScope(rule.scope, camp.current_phase);
        if (!shouldApply) continue;

        const metricValue = getMetricValue(camp, rule.metric);
        const triggered = evaluateCondition(metricValue, rule.operator, rule.value);

        if (triggered) {
          await executeAction(camp, rule, token, camp.user_id, logs);
          actionsTaken++;
        }
      }

      // 7. Evaluate A/B test copies
      await evaluateABTest(camp, scheme, token, logs);
    }

    // Send WA summary if actions taken
    if (actionsTaken > 0) {
      await sendWASummary(actionsTaken, logs);
    }

    return res.status(200).json({
      success: true,
      actions_taken: actionsTaken,
      logs
    });
  } catch (err) {
    console.error('autopilot-run error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function getMetricValue(camp, metric) {
  const map = {
    cpr: camp.cpr,
    ctr: camp.ctr,
    roas: camp.roas,
    spend: camp.spend_today,
    days: camp.days_running || 0
  };
  return map[metric];
}

function evaluateCondition(value, operator, threshold) {
  if (value === null || value === undefined) return false;
  const v = parseFloat(value);
  const t = parseFloat(threshold);
  switch (operator) {
    case 'gt': return v > t;
    case 'lt': return v < t;
    case 'gte': return v >= t;
    case 'lte': return v <= t;
    default: return false;
  }
}

function matchesScope(scope, currentPhase) {
  if (!scope || scope === 'all') return true;
  if (scope === 'phase1') return currentPhase === 1;
  if (scope === 'phase2') return currentPhase === 2;
  if (scope === 'phase3') return currentPhase === 3;
  return true;
}

async function executeAction(camp, rule, token, userId, logs) {
  const logEntry = {
    campaign_id: camp.id,
    campaign_name: camp.name,
    user_id: userId,
    action_type: rule.action_type,
    reason: `Rule: ${rule.name}`,
    status: 'success'
  };

  try {
    switch (rule.action_type) {
      case 'pause':
        await pauseCampaign(camp, token);
        logEntry.description = `Kampanye "${camp.name}" di-pause`;
        break;

      case 'resume':
        await resumeCampaign(camp, token);
        logEntry.description = `Kampanye "${camp.name}" diaktifkan kembali`;
        break;

      case 'increase_budget': {
        const pct = parseFloat(rule.action_value) || 20;
        const newBudget = Math.floor(camp.daily_budget * (1 + pct / 100));
        await updateBudget(camp, newBudget, token);
        logEntry.description = `Budget "${camp.name}" dinaikkan ${pct}% → Rp ${newBudget.toLocaleString('id-ID')}`;
        break;
      }

      case 'decrease_budget': {
        const pct = parseFloat(rule.action_value) || 20;
        const newBudget = Math.floor(camp.daily_budget * (1 - pct / 100));
        await updateBudget(camp, Math.max(newBudget, 10000), token);
        logEntry.description = `Budget "${camp.name}" dikurangi ${pct}%`;
        break;
      }

      case 'replace_content':
        await replaceContent(camp, userId);
        logEntry.description = `Konten "${camp.name}" diganti dari library`;
        break;

      case 'notify':
        logEntry.description = `Notifikasi dikirim untuk "${camp.name}"`;
        break;
    }

    await sb.from('action_logs').insert(logEntry);
    logs.push(logEntry);
  } catch (err) {
    logEntry.status = 'error';
    logEntry.description = err.message;
    await sb.from('action_logs').insert(logEntry);
    console.error(`executeAction error for ${camp.name}:`, err.message);
  }
}

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

async function resumeCampaign(camp, token) {
  if (camp.meta_campaign_id && token) {
    await fetch(`${META_API}/${camp.meta_campaign_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ACTIVE', access_token: token })
    });
  }
  await sb.from('campaigns').update({ status: 'ACTIVE' }).eq('id', camp.id);
}

async function updateBudget(camp, newBudget, token) {
  if (camp.meta_adset_id && token) {
    await fetch(`${META_API}/${camp.meta_adset_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daily_budget: newBudget * 100, access_token: token })
    });
  }
  await sb.from('campaigns').update({ daily_budget: newBudget }).eq('id', camp.id);
}

async function replaceContent(camp, userId) {
  // Find next ready content in library
  const { data: nextContent } = await sb.from('content_library')
    .select('*').eq('user_id', userId).eq('status', 'ready')
    .neq('id', camp.content_id).limit(1).single();

  if (!nextContent) return;

  // Mark old content as used
  await sb.from('content_library').update({ status: 'used' }).eq('id', camp.content_id);

  // Update campaign content
  await sb.from('campaigns').update({
    content_id: nextContent.id,
    current_phase: 1 // restart to testing phase
  }).eq('id', camp.id);
}

async function checkPhaseAdvancement(camp, scheme, token, logs) {
  const daysRunning = camp.days_running || 0;
  const targetCPR = scheme?.target_cpr;
  const targetROAS = scheme?.target_roas;

  let newPhase = camp.current_phase;

  // Phase 1 → 2: after 3 days
  if (camp.current_phase === 1 && daysRunning >= 3) {
    newPhase = 2;
  }

  // Phase 2 → 3: after 7 days & performance meets target
  if (camp.current_phase === 2 && daysRunning >= 7) {
    const performanceGood = !targetCPR || (camp.cpr && camp.cpr <= targetCPR);
    if (performanceGood) newPhase = 3;
  }

  if (newPhase !== camp.current_phase) {
    await sb.from('campaigns').update({
      current_phase: newPhase,
      phase_started_at: new Date().toISOString()
    }).eq('id', camp.id);

    const phaseLabel = { 2: 'Evaluasi', 3: 'Scale' };
    logs.push({
      campaign_name: camp.name,
      action_type: 'phase_advance',
      description: `Kampanye "${camp.name}" maju ke Phase ${newPhase}: ${phaseLabel[newPhase]}`
    });
  }

  // Increment days counter
  await sb.from('campaigns').update({
    days_running: daysRunning + 1
  }).eq('id', camp.id);
}

async function evaluateABTest(camp, scheme, token, logs) {
  const { data: copies } = await sb.from('ad_copies')
    .select('*').eq('campaign_id', camp.id).eq('ab_test', true).eq('status', 'testing');

  if (!copies || copies.length < 2) return;

  // Find winner (lowest CPR or highest CTR)
  const withMetrics = copies.filter(c => c.ctr !== null);
  if (withMetrics.length < 2) return;

  // Check if running >= 3 days
  const oldestCopy = copies.reduce((a, b) => new Date(a.created_at) < new Date(b.created_at) ? a : b);
  const daysSinceStart = (Date.now() - new Date(oldestCopy.created_at).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceStart < 3) return;

  // Pick winner: highest CTR
  const winner = [...withMetrics].sort((a, b) => (b.ctr || 0) - (a.ctr || 0))[0];
  const losers = withMetrics.filter(c => c.id !== winner.id);

  // Mark winner
  await sb.from('ad_copies').update({ status: 'winner' }).eq('id', winner.id);

  // Pause losers
  for (const loser of losers) {
    await sb.from('ad_copies').update({ status: 'paused' }).eq('id', loser.id);
  }

  logs.push({
    campaign_name: camp.name,
    action_type: 'ab_winner',
    description: `A/B test "${camp.name}" selesai. Pemenang: "${winner.headline}" (CTR: ${winner.ctr?.toFixed(2)}%)`
  });
}

async function sendWASummary(count, logs) {
  try {
    const { data: configs } = await sb.from('app_config')
      .select('fonnte_token, wa_target').not('fonnte_token', 'is', null);

    for (const config of (configs || [])) {
      if (!config.fonnte_token || !config.wa_target) continue;

      const summary = logs.slice(0, 5).map(l => `• ${l.description || l.action_type}`).join('\n');
      const message = `🤖 *Adsy Autopilot*\n\n${count} aksi dijalankan:\n${summary}\n\nLihat detail di dashboard.`;

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
