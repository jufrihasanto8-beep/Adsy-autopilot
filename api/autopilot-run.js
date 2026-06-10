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

  // ── Manual advance phase (dari user, bukan cron) ──
  if (req.method === 'POST' && req.body?.action === 'advance_phase') {
    return await manualAdvancePhase(req, res);
  }

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
    // ── Cek status billing semua ad account ──
    await checkAdAccountStatuses();

    // ── Sync status kampanye dari Meta (pause/delete) sebelum rules engine jalan ──
    await syncAllCampaignsFromMeta();

    // Ambil semua kampanye aktif dengan autopilot, join ke products untuk target CPR
    const { data: campaigns } = await sb.from('campaigns')
      .select('*, products(target_cpr, target_roas, target_cpr_ctwa)')
      .eq('status', 'ACTIVE')
      .eq('autopilot_enabled', true)
      .neq('campaign_type', 'ctwa'); // CTWA autopilot belum dibangun, skip dulu

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
          .select('*, products(target_cpr, target_roas, target_cpr_ctwa)')
          .eq('id', camp.id).single();
        if (!fresh) continue;

        const targetCpr = fresh.campaign_type === 'ctwa'
          ? (fresh.products?.target_cpr_ctwa || null)
          : (fresh.products?.target_cpr || null);
        const targetRoas = fresh.products?.target_roas || null;
        const impressions = fresh.impressions || 0;

        // ── Hitung hari berjalan dari phase_started_at (akurat, tidak terpengaruh frekuensi cron) ──
        const startDate  = fresh.phase_started_at ? new Date(fresh.phase_started_at) : new Date(fresh.created_at);
        const today      = new Date();
        const daysRunning = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));
        await sb.from('campaigns').update({ days_running: daysRunning }).eq('id', fresh.id);

        // ── Winner Detection — cek sebelum rules lain ──
        await checkWinner(fresh, targetCpr, token, logs);

        // ── Blueprint Rules (pause/budget) — jalan tanpa nunggu impressions ──
        const acted = await runBlueprintRules(fresh, targetCpr, targetRoas, token, logs);
        if (acted) actionsTaken++;

        // ── Phase Advancement — impressions 8.000 hanya dicek saat hari ke-3 (di dalam fungsi) ──
        await checkPhaseAdvancement(fresh, targetCpr, daysRunning, token, logs);

        // Re-fetch lagi setelah phase advance untuk custom rules
        const { data: latest } = await sb.from('campaigns')
          .select('*, products(target_cpr, target_roas, target_cpr_ctwa)')
          .eq('id', fresh.id).single();
        if (!latest || !latest.autopilot_enabled || latest.status === 'PAUSED') continue;

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

// ── Sync status semua kampanye dari Meta (pause/delete) ──
async function syncAllCampaignsFromMeta() {
  try {
    // Ambil semua user yang punya kampanye dengan meta_campaign_id
    const { data: userRows } = await sb.from('campaigns')
      .select('user_id, ad_account_id')
      .not('meta_campaign_id', 'is', null);
    if (!userRows?.length) return;

    // Group by user_id + ad_account_id (unique pairs)
    const pairs = [...new Map(userRows.map(r => [`${r.user_id}|${r.ad_account_id}`, r])).values()];

    for (const { user_id, ad_account_id } of pairs) {
      try {
        const { data: config } = await sb.from('app_config')
          .select('meta_token').eq('user_id', user_id).single();
        const token = config?.meta_token || process.env.META_ACCESS_TOKEN;
        if (!token) continue;

        const fields = 'id,name,status';
        const metaRes = await fetch(
          `https://graph.facebook.com/v18.0/${ad_account_id}/campaigns?fields=${fields}&effective_status=["ACTIVE","PAUSED","ARCHIVED","DELETED"]&limit=500&access_token=${encodeURIComponent(token)}`
        );
        const metaData = await metaRes.json();
        if (metaData.error || !metaData.data) continue;

        const metaIds = new Set(metaData.data.map(c => c.id));

        for (const camp of metaData.data) {
          const isDeleted = camp.status === 'DELETED' || camp.status === 'ARCHIVED';
          if (isDeleted) {
            const { data: existing } = await sb.from('campaigns')
              .select('id').eq('meta_campaign_id', camp.id).single();
            if (existing) {
              await sb.from('ad_copies').delete().eq('campaign_id', existing.id);
              await sb.from('campaigns').delete().eq('id', existing.id);
            }
          } else {
            await sb.from('campaigns').update({ status: camp.status, name: camp.name })
              .eq('meta_campaign_id', camp.id);
          }
        }

        // Hapus kampanye di Supabase yang tidak ada lagi di Meta
        const { data: sbCamps } = await sb.from('campaigns')
          .select('id, meta_campaign_id')
          .eq('user_id', user_id)
          .eq('ad_account_id', ad_account_id)
          .not('meta_campaign_id', 'is', null);

        for (const sbCamp of (sbCamps || [])) {
          if (!metaIds.has(sbCamp.meta_campaign_id)) {
            await sb.from('ad_copies').delete().eq('campaign_id', sbCamp.id);
            await sb.from('campaigns').delete().eq('id', sbCamp.id);
          }
        }

      } catch (e) {
        console.error('syncAllCampaignsFromMeta error for', ad_account_id, e.message);
      }
    }
  } catch (e) {
    console.error('syncAllCampaignsFromMeta error:', e.message);
  }
}

// ── Sync insights dari Meta (impressions, CPR, CTR, spend) ──
async function syncCampaignInsights(camp, token) {
  if ((!camp.meta_campaign_id && !camp.meta_adset_id) || !token) return;
  try {
    const fields = 'impressions,spend,clicks,ctr,actions';
    // Pakai adset-level kalau ada (lebih akurat, khususnya untuk Phase 2b multi-adset)
    const targetId = camp.meta_adset_id || camp.meta_campaign_id;
    const res = await fetch(
      `${META_API}/${targetId}/insights?fields=${fields}&date_preset=today&access_token=${encodeURIComponent(token)}`
    );
    const data = await res.json();
    const insight = data?.data?.[0];
    if (!insight) return;

    const impressions = parseInt(insight.impressions || 0);
    const spend       = parseFloat(insight.spend || 0); // Meta return IDR langsung untuk akun IDR
    const ctr         = parseFloat(insight.ctr || 0);

    // CPR = spend / results — deteksi berdasarkan campaign_type
    const actions = insight.actions || [];
    const resultAction = camp.campaign_type === 'ctwa'
      ? actions.find(x => x.action_type === 'onsite_conversion.messaging_conversation_started_7d')
      : actions.find(x => x.action_type === 'offsite_conversion.fb_pixel_purchase' || x.action_type === 'lead');
    const results = parseInt(resultAction?.value || 0);
    // cpr = null kalau spend ada tapi konversi 0 (bukan sekadar belum ada data)
    // undefined = jangan update DB (spend 0 = belum ada data hari ini)
    const cpr = results > 0
      ? Math.round(spend / results)
      : (spend > 0 ? null : undefined);

    await sb.from('campaigns').update({
      impressions,
      spend_today: spend,
      ctr,
      results_today: results,
      ...(cpr !== undefined ? { cpr } : {})
    }).eq('id', camp.id);

  } catch (err) {
    console.error('syncInsights error:', err.message);
  }
}

// ── Phase Advancement sesuai DIMENSI blueprint ──
async function checkPhaseAdvancement(camp, targetCpr, daysRunning, token, logs) {
  let newPhase = camp.current_phase;
  const cpr = camp.cpr;

  // Phase 1 → 2: min 3 hari + seleksi CPR (tidak ada syarat impresi minimum)
  // Skip kalau Phase 1 sudah winning (initial_budget tersimpan) — dikelola oleh runBlueprintRules
  if (camp.current_phase === 1 && daysRunning >= 3 && !camp.initial_budget) {
    if (!targetCpr) {
      // Tidak ada target CPR → langsung maju
      newPhase = 2;
    } else if (cpr === null) {
      // Tidak ada konversi sama sekali setelah 3 hari → pause permanen langsung
      await pauseCampaign(camp, token);
      await sb.from('campaigns').update({ autopilot_enabled: false }).eq('id', camp.id);
      const logEntry = {
        user_id: camp.user_id,
        campaign_name: camp.name,
        action_type: 'pause',
        description: `"${camp.name}" dihentikan permanen — 0 konversi selama ${daysRunning} hari`,
        status: 'success'
      };
      await sb.from('action_logs').insert(logEntry);
      logs.push(logEntry);
      return;
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
      // CPR terlalu jelek setelah 3 hari → pause permanen (di Meta + Supabase)
      await pauseCampaign(camp, token);
      await sb.from('campaigns').update({ autopilot_enabled: false }).eq('id', camp.id);
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

  // Phase 2 — Evaluasi hari ke-7 (Phase 3 belum diimplementasi)
  if (camp.current_phase === 2 && daysRunning >= 7 && targetCpr) {
    if (cpr === null) {
      // 0 konversi selama 7 hari → pause permanen
      await pauseCampaign(camp, token);
      await sb.from('campaigns').update({ autopilot_enabled: false }).eq('id', camp.id);
      const logEntry = {
        user_id: camp.user_id,
        campaign_name: camp.name,
        action_type: 'pause',
        description: `"${camp.name}" dihentikan permanen — 0 konversi selama ${daysRunning} hari di Phase 2`,
        status: 'success'
      };
      await sb.from('action_logs').insert(logEntry);
      logs.push(logEntry);
      return;
    } else if (cpr > targetCpr * 1.1) {
      // CPR masih > +10% target setelah 7 hari → pause permanen
      await pauseCampaign(camp, token);
      await sb.from('campaigns').update({ autopilot_enabled: false }).eq('id', camp.id);
      const logEntry = {
        user_id: camp.user_id,
        campaign_name: camp.name,
        action_type: 'pause',
        description: `"${camp.name}" dihentikan permanen — CPR Rp ${Math.round(cpr).toLocaleString('id-ID')} masih > +10% target setelah ${daysRunning} hari di Phase 2`,
        status: 'success'
      };
      await sb.from('action_logs').insert(logEntry);
      logs.push(logEntry);
      return;
    }
    // CPR ≤ target + 10% → tetap jalan (Phase 3 belum ada)
  }

  if (newPhase === 2 && camp.current_phase === 1 && !camp.initial_budget) {
    // Ambil data produk untuk Phase 2b interest
    const { data: product } = await sb.from('products')
      .select('name, tagline, benefits')
      .eq('id', camp.product_id).single();

    // Buat Phase 2a & 2b — initial_budget di-set setelah keduanya sukses
    await createPhase2Campaign(camp, token, logs);
    await createPhase2bCampaign(camp, token, product, logs);

    await sb.from('campaigns').update({ initial_budget: camp.daily_budget }).eq('id', camp.id);

    const logEntry = {
      user_id: camp.user_id,
      campaign_name: camp.name,
      action_type: 'phase_advance',
      description: `"${camp.name}" lolos Phase 1 → kampanye Phase 2a & 2b dibuat`,
      status: 'success'
    };
    await sb.from('action_logs').insert(logEntry);
    logs.push(logEntry);
    // Phase 1 tidak diubah apapun — tetap jalan dengan autopilot aktif
  }

  // Phase 3 belum diimplementasi — akan ditambahkan nanti
}

// ── Buat kampanye Phase 2a di Meta (build from scratch, bukan deep copy) ──
// Deep copy tidak bisa ganti bid_strategy & budget type → buat baru ambil creative dari Phase 1
async function createPhase2Campaign(camp, token, logs) {
  if (!camp.meta_campaign_id || !token) return;

  try {
    // 1. Ambil info campaign Phase 1: objective + account_id
    const campInfoRes = await fetch(
      `${META_API}/${camp.meta_campaign_id}?fields=account_id,objective&access_token=${encodeURIComponent(token)}`
    );
    const campInfo = await campInfoRes.json();
    if (campInfo.error) throw new Error('Gagal ambil info kampanye: ' + campInfo.error.message);
    const rawAccountId = campInfo.account_id;
    if (!rawAccountId) throw new Error('Tidak bisa ambil account_id dari kampanye Phase 1');
    const accountId = rawAccountId.startsWith('act_') ? rawAccountId : `act_${rawAccountId}`;

    // Normalisasi objective: Meta kadang return format lama (CONVERSIONS, LINK_CLICKS, dll)
    const objectiveMap = {
      'LINK_CLICKS': 'OUTCOME_TRAFFIC',
      'CONVERSIONS': 'OUTCOME_SALES',
      'LEAD_GENERATION': 'OUTCOME_LEADS',
      'POST_ENGAGEMENT': 'OUTCOME_ENGAGEMENT',
      'BRAND_AWARENESS': 'OUTCOME_AWARENESS',
      'REACH': 'OUTCOME_AWARENESS',
      'VIDEO_VIEWS': 'OUTCOME_ENGAGEMENT',
      'APP_INSTALLS': 'OUTCOME_APP_PROMOTION',
    };
    const rawObjective = campInfo.objective || 'OUTCOME_SALES';
    const objective = objectiveMap[rawObjective] || rawObjective;

    // 2. Ambil targeting dari adset Phase 1
    let targeting = { age_min: 21, geo_locations: { countries: ['ID'] }, targeting_automation: { advantage_audience: 0 } };
    let promotedObject = null;
    let optimizationGoal = 'OFFSITE_CONVERSIONS';
    let billingEvent = 'IMPRESSIONS';

    if (camp.meta_adset_id) {
      const adsetInfoRes = await fetch(
        `${META_API}/${camp.meta_adset_id}?fields=targeting,promoted_object,optimization_goal,billing_event&access_token=${encodeURIComponent(token)}`
      );
      const adsetInfo = await adsetInfoRes.json();
      if (!adsetInfo.error) {
        if (adsetInfo.targeting) {
          // Copy targeting dari Phase 1, strip field yang tidak kompatibel dengan Advantage+ OFF
          const STRIP_FIELDS = [
            'brand_safety_content_filter_levels',
            'brand_safety_inventory_filter',
            'place_page_set_ids',
            'age_range',         // Advantage+-only field, konflik dengan advantage_audience: 0
            'targeting_automation' // akan di-set manual di bawah
          ];
          const t = { ...adsetInfo.targeting };
          STRIP_FIELDS.forEach(f => delete t[f]);
          // Matikan Advantage+ supaya age_min/age_max + interest manual berlaku
          t.targeting_automation = { advantage_audience: 0 };
          targeting = t;
        }
        promotedObject = adsetInfo.promoted_object || null;
        optimizationGoal = adsetInfo.optimization_goal || 'OFFSITE_CONVERSIONS';
        billingEvent = adsetInfo.billing_event || 'IMPRESSIONS';
      }
    }

    // 3. Ambil creative dari ads Phase 1
    const adsRes = await fetch(
      `${META_API}/${camp.meta_campaign_id}/ads?fields=creative{id}&access_token=${encodeURIComponent(token)}`
    );
    const adsData = await adsRes.json();
    const creativeId = adsData.data?.[0]?.creative?.id;

    // 4. Hitung bid amount COST_CAP = CPR Phase 1 + 10%
    //    Fallback ke target_cpr produk + 10% kalau CPR belum ada
    const targetCpr = camp.products?.target_cpr;
    const baseCpr = camp.cpr || targetCpr;
    const bidAmount = baseCpr ? Math.round(baseCpr * 1.1) : null;

    // 5. Buat campaign CBO + Cost Cap di level kampanye
    const campBody = {
      name: camp.name + ' — Phase 2a',
      objective,
      status: 'PAUSED',
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
      daily_budget: 5000000,
      bid_strategy: bidAmount ? 'COST_CAP' : 'LOWEST_COST_WITHOUT_CAP',
      access_token: token
      // bid_amount TIDAK di campaign — untuk CBO COST_CAP, bid_amount ada di adset
    };

    const newCampRes = await fetch(`${META_API}/${accountId}/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(campBody)
    });
    const newCampData = await newCampRes.json();
    if (newCampData.error) {
      const e = newCampData.error;
      throw new Error('Gagal buat campaign: ' + (e.error_user_msg || e.message) + ` (code: ${e.code})`);
    }
    const newCampaignId = newCampData.id;

    // 6. Buat adset — CBO, bid_amount di sini (bukan di campaign)
    const adsetBody = {
      name: camp.name + ' — Phase 2a',
      campaign_id: newCampaignId,
      billing_event: billingEvent,
      optimization_goal: optimizationGoal,
      targeting,
      status: 'PAUSED',
      access_token: token
    };
    if (bidAmount) adsetBody.bid_amount = bidAmount;
    if (promotedObject) adsetBody.promoted_object = promotedObject;

    const newAdsetRes = await fetch(`${META_API}/${accountId}/adsets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(adsetBody)
    });
    const newAdsetData = await newAdsetRes.json();
    if (newAdsetData.error) {
      const e = newAdsetData.error;
      throw new Error('Gagal buat adset: ' + (e.error_user_msg || e.message) + ` (code: ${e.code})`);
    }
    const newAdsetId = newAdsetData.id;

    // 7. Buat ad dengan creative yang sama dari Phase 1
    let newAdId = null;
    if (creativeId) {
      const adRes = await fetch(`${META_API}/${accountId}/ads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: camp.name + ' — Phase 2a',
          adset_id: newAdsetId,
          creative: { creative_id: creativeId },
          status: 'PAUSED',
          access_token: token
        })
      });
      const adData = await adRes.json();
      newAdId = adData.id || null;
    }

    // 8. Aktifkan campaign + adset + ad sekaligus
    await Promise.all([
      fetch(`${META_API}/${newCampaignId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ACTIVE', access_token: token })
      }),
      fetch(`${META_API}/${newAdsetId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ACTIVE', access_token: token })
      }),
      ...(newAdId ? [fetch(`${META_API}/${newAdId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ACTIVE', access_token: token })
      })] : [])
    ]);

    // 9. Simpan ke Supabase
    await sb.from('campaigns').insert({
      user_id: camp.user_id,
      ad_account_id: camp.ad_account_id,
      name: camp.name + ' — Phase 2a',
      status: 'ACTIVE',
      current_phase: 2,
      phase_type: '2a',
      phase_started_at: new Date().toISOString(),
      autopilot_enabled: true,
      product_id: camp.product_id,
      daily_budget: 5000000,
      meta_campaign_id: newCampaignId,
      meta_adset_id: newAdsetId,
      days_running: 0
    });

    const logEntry = {
      user_id: camp.user_id,
      campaign_name: camp.name + ' — Phase 2a',
      action_type: 'create',
      description: `Kampanye Phase 2a dibuat — Budget Rp 5.000.000, COST_CAP Rp ${bidAmount ? bidAmount.toLocaleString('id-ID') : '(tidak diset, CPR belum ada)'}`,
      status: 'success'
    };
    await sb.from('action_logs').insert(logEntry);
    logs.push(logEntry);

  } catch (err) {
    console.error('createPhase2Campaign error:', err.message);
    try { await sb.from('action_logs').insert({
      user_id: camp.user_id,
      campaign_name: camp.name,
      action_type: 'create',
      description: `Gagal buat kampanye Phase 2a: ${err.message}`,
      status: 'error'
    }); } catch(e) {}
    throw err; // propagate ke manualAdvancePhase / checkPhaseAdvancement
  }
}

// ── Winner Detection ──
// Tandai campaign sebagai winner kalau CPR <= target AND spend >= minimum threshold
async function checkWinner(camp, targetCpr, token, logs) {
  if (!targetCpr || camp.is_winner) return; // Sudah winner atau tidak ada target
  const cpr = camp.cpr;
  const spend = camp.spend_today || 0;
  const MIN_SPEND = 30000; // Minimal Rp 30.000 spend sebelum bisa dianggap winner

  if (cpr !== null && cpr > 0 && cpr <= targetCpr && spend >= MIN_SPEND) {
    await sb.from('campaigns').update({
      is_winner: true,
      winner_at: new Date().toISOString()
    }).eq('id', camp.id);

    const logEntry = {
      user_id: camp.user_id,
      campaign_name: camp.name,
      action_type: 'winner',
      description: `🏆 "${camp.name}" jadi WINNER! CPR Rp ${Math.round(cpr).toLocaleString('id-ID')} ≤ target Rp ${Math.round(targetCpr).toLocaleString('id-ID')}`,
      status: 'success'
    };
    await sb.from('action_logs').insert(logEntry);
    logs.push(logEntry);

    // WA Notif winner
    try {
      const { data: cfg } = await sb.from('app_config').select('fonnte_token, wa_number').eq('user_id', camp.user_id).single();
      if (cfg?.fonnte_token && cfg?.wa_number) {
        await fetch('https://api.fonnte.com/send', {
          method: 'POST',
          headers: { 'Authorization': cfg.fonnte_token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target: cfg.wa_number,
            message: `🏆 *WINNER DETECTED!*\n\nKampanye: *${camp.name}*\nCPR: Rp ${Math.round(cpr).toLocaleString('id-ID')}\nTarget: Rp ${Math.round(targetCpr).toLocaleString('id-ID')}\n\nIklan ini performa di atas target! Pertimbangkan untuk scale budget. 🚀`
          })
        });
      }
    } catch (e) {
      console.error('WA winner notif error:', e.message);
    }
  }
}

// ── Blueprint Rules utama ──
async function runBlueprintRules(camp, targetCpr, targetRoas, token, logs) {
  if (!targetCpr) return false; // Tidak ada target = skip blueprint rules

  const cpr         = camp.cpr;
  const budget      = camp.daily_budget || 50000;
  const currentPhase = camp.current_phase;
  const today       = new Date().toISOString().slice(0, 10);

  // Phase 1: Testing
  if (currentPhase === 1 && cpr !== null && cpr !== undefined) {

    // Phase 1 Winning (Phase 2 sudah dibuat = initial_budget tersimpan)
    if (camp.initial_budget) {
      const resultsToday = camp.results_today || 0;
      const lastResults  = camp.last_results || 0;
      const cprHistory   = Array.isArray(camp.cpr_history) ? camp.cpr_history : [];

      // Catat CPR hari ini ke history (sekali per hari)
      const lastRecordedDate = cprHistory.length > 0 ? cprHistory[cprHistory.length - 1]?.date : null;
      if (lastRecordedDate !== today && cpr !== null) {
        const updatedHistory = [...cprHistory, { date: today, cpr }];
        await sb.from('campaigns').update({ cpr_history: updatedHistory }).eq('id', camp.id);
        camp.cpr_history = updatedHistory; // update local reference
      }

      // ── Evaluasi hari ke-7: rata-rata CPR ──
      const winningDays = Math.floor((new Date() - new Date(camp.phase_started_at || camp.created_at)) / (1000 * 60 * 60 * 24));
      if (winningDays >= 7 && camp.cpr_history?.length >= 3) {
        const avgCpr = camp.cpr_history.reduce((sum, d) => sum + d.cpr, 0) / camp.cpr_history.length;

        if (avgCpr > targetCpr * 1.1) {
          // Rata-rata CPR > +10% target → pause permanen
          await pauseCampaign(camp, token);
          await sb.from('campaigns').update({ autopilot_enabled: false }).eq('id', camp.id);
          const logEntry = {
            user_id: camp.user_id,
            campaign_name: camp.name,
            action_type: 'pause',
            description: `"${camp.name}" dihentikan permanen setelah 7 hari — rata-rata CPR Rp ${Math.round(avgCpr).toLocaleString('id-ID')} > +10% target`,
            status: 'success'
          };
          await sb.from('action_logs').insert(logEntry);
          logs.push(logEntry);
          return true;
        }
        // Rata-rata CPR ≤ +10% target → tetap jalan terus (tidak ada aksi)
      }

      // CPR > 2× target → pause sementara, hidup jam 3 pagi + budget reset
      if (cpr > targetCpr * 2) {
        await pauseCampaign(camp, token);
        const logEntry = {
          user_id: camp.user_id,
          campaign_name: camp.name,
          action_type: 'pause',
          description: `"${camp.name}" di-pause (Phase 1 Winning) — CPR Rp ${Math.round(cpr).toLocaleString('id-ID')} > 2× target`,
          status: 'success'
        };
        await sb.from('action_logs').insert(logEntry);
        logs.push(logEntry);
        return true;
      }

      // Hasil naik ≥ 2 dari sebelumnya + CPR ≤ target → naik budget 30%
      if (resultsToday >= lastResults + 2 && cpr <= targetCpr) {
        const newBudget = Math.floor(budget * 1.3);
        await updateBudget(camp, newBudget, token);
        await sb.from('campaigns').update({ last_results: resultsToday }).eq('id', camp.id);
        const logEntry = {
          user_id: camp.user_id,
          campaign_name: camp.name,
          action_type: 'increase_budget',
          description: `"${camp.name}" budget naik 30% → Rp ${newBudget.toLocaleString('id-ID')} (hasil ${lastResults} → ${resultsToday}, CPR ≤ target)`,
          status: 'success'
        };
        await sb.from('action_logs').insert(logEntry);
        logs.push(logEntry);
        return true;
      }

      return false; // Phase 1 Winning: tidak ada aksi lain
    }

    // Phase 1 biasa (belum winning) — pause kalau CPR > 2.5× target
    if (cpr > targetCpr * 2.5) {
      await pauseCampaign(camp, token);
      const logEntry = {
        user_id: camp.user_id,
        campaign_name: camp.name,
        action_type: 'pause',
        description: `"${camp.name}" di-pause di Phase 1 — CPR Rp ${Math.round(cpr).toLocaleString('id-ID')} (> 2.5× target)`,
        status: 'success'
      };
      await sb.from('action_logs').insert(logEntry);
      logs.push(logEntry);
      return true;
    }
  }

  // Cegah multiple budget change dalam satu hari (Phase 2 & 3 saja)
  if (camp.last_budget_change_date === today) return false;

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

  // Phase 2: skema sama Phase 1 — pause/naik/turun budget
  if (currentPhase === 2 && cpr !== null) {
    // Hitung days running untuk Phase 2 (hindari double-action di hari ke-7)
    const phase2Start = camp.phase_started_at ? new Date(camp.phase_started_at) : new Date(camp.created_at);
    const phase2Days = Math.floor((new Date() - phase2Start) / (1000 * 60 * 60 * 24));

    // CPR > 2.5× target → pause sementara (skip kalau hari ke-7+, checkPhaseAdvancement yang handle)
    if (cpr > targetCpr * 2.5 && phase2Days < 7) {
      await pauseCampaign(camp, token);
      const logEntry = {
        user_id: camp.user_id,
        campaign_name: camp.name,
        action_type: 'pause',
        description: `"${camp.name}" di-pause di Phase 2 — CPR Rp ${Math.round(cpr).toLocaleString('id-ID')} (> 2.5× target)`,
        status: 'success'
      };
      await sb.from('action_logs').insert(logEntry);
      logs.push(logEntry);
      return true;
    }

    // CPR ≤ target → naik budget 3%
    if (cpr <= targetCpr) {
      const newBudget = Math.floor(budget * (1 + SCALE_PCT / 100));
      await updateBudget(camp, newBudget, token);
      const logEntry = {
        user_id: camp.user_id,
        campaign_name: camp.name,
        action_type: 'increase_budget',
        description: `"${camp.name}" budget naik ${SCALE_PCT}% → Rp ${newBudget.toLocaleString('id-ID')} (CPR ≤ target)`,
        status: 'success'
      };
      await sb.from('action_logs').insert(logEntry);
      logs.push(logEntry);
      return true;
    }

    // CPR > target (tapi ≤ 2.5×) → turun budget 3%
    if (cpr > targetCpr) {
      const newBudget = Math.max(Math.floor(budget * (1 - SCALE_PCT / 100)), 10000);
      await updateBudget(camp, newBudget, token);
      const logEntry = {
        user_id: camp.user_id,
        campaign_name: camp.name,
        action_type: 'decrease_budget',
        description: `"${camp.name}" budget turun ${SCALE_PCT}% → Rp ${newBudget.toLocaleString('id-ID')} (CPR > target)`,
        status: 'success'
      };
      await sb.from('action_logs').insert(logEntry);
      logs.push(logEntry);
      return true;
    }
  }

  return false;
}

// ── Buat kampanye Phase 2b (ABO, 3 adset interest) ──
async function createPhase2bCampaign(camp, token, product, logs) {
  if (!token || !camp.meta_campaign_id) return;

  try {
    // 1. Ambil account_id + objective dari kampanye Phase 1
    const campInfoRes = await fetch(
      `${META_API}/${camp.meta_campaign_id}?fields=account_id,objective&access_token=${encodeURIComponent(token)}`
    );
    const campInfo = await campInfoRes.json();
    if (campInfo.error) throw new Error('Gagal ambil info kampanye: ' + campInfo.error.message);
    const accountId = campInfo.account_id;
    if (!accountId) throw new Error('Tidak bisa ambil account_id');
    const objectiveMapB = {
      'LINK_CLICKS': 'OUTCOME_TRAFFIC', 'CONVERSIONS': 'OUTCOME_SALES',
      'LEAD_GENERATION': 'OUTCOME_LEADS', 'POST_ENGAGEMENT': 'OUTCOME_ENGAGEMENT',
      'BRAND_AWARENESS': 'OUTCOME_AWARENESS', 'REACH': 'OUTCOME_AWARENESS',
    };
    const objective = objectiveMapB[campInfo.objective] || campInfo.objective || 'OUTCOME_SALES';

    // 2. Ambil creative dari ads Phase 1
    const adsRes = await fetch(
      `${META_API}/${camp.meta_campaign_id}/ads?fields=creative{id}&access_token=${encodeURIComponent(token)}`
    );
    const adsData = await adsRes.json();
    const creativeId = adsData.data?.[0]?.creative?.id;

    // 3. Ambil pixel_id + page_id dari ad_accounts untuk promoted_object
    const { data: adAcc } = await sb.from('ad_accounts')
      .select('pixel_id, page_id')
      .eq('user_id', camp.user_id)
      .maybeSingle();
    const pixelId = adAcc?.pixel_id;
    const pageId  = adAcc?.page_id;

    // optimization_goal & promoted_object sesuai objective
    const optimizationGoalMap = {
      'OUTCOME_SALES':      'OFFSITE_CONVERSIONS',
      'OUTCOME_LEADS':      'LEAD_GENERATION',
      'OUTCOME_ENGAGEMENT': 'POST_ENGAGEMENT',
      'OUTCOME_AWARENESS':  'REACH',
      'OUTCOME_TRAFFIC':    'LINK_CLICKS'
    };
    const optimizationGoal = optimizationGoalMap[objective] || 'OFFSITE_CONVERSIONS';

    let promotedObject = null;
    if (objective === 'OUTCOME_SALES' && pixelId) {
      promotedObject = { pixel_id: pixelId, custom_event_type: 'PURCHASE' };
    } else if (pageId) {
      promotedObject = { page_id: pageId };
    }

    // 4. Generate keyword per kategori via Claude
    const keywords = await generateInterestKeywords(product);

    // 5. Cari interest di Meta per kategori
    const interests = await searchInterestsPerCategory(keywords, token);

    // Log interests yang ditemukan supaya bisa debug
    const interestSummary = Object.entries(interests).map(([k, v]) => `${k}: ${v.length} (${v.slice(0,2).map(i=>i.name).join(', ')})`).join(' | ');
    console.log('Phase 2b interests found:', interestSummary);
    try { await sb.from('action_logs').insert({
      user_id: camp.user_id, campaign_name: camp.name, action_type: 'create',
      description: `Phase 2b interests: ${interestSummary || 'semua kosong — pakai broad targeting'}`,
      status: 'info'
    }); } catch(e) {}

    // 6. Buat campaign ABO
    const newCampRes = await fetch(`${META_API}/act_${accountId}/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: camp.name + ' — Phase 2b',
        objective,
        status: 'ACTIVE',
        special_ad_categories: [],
        is_adset_budget_sharing_enabled: false,
        access_token: token
      })
    });
    const newCampData = await newCampRes.json();
    if (newCampData.error) {
      const e = newCampData.error;
      throw new Error('Gagal buat campaign 2b: ' + (e.error_user_msg || e.message) + ` (code: ${e.code})`);
    }
    const newCampaignId = newCampData.id;
    if (!newCampaignId) throw new Error('Gagal buat campaign 2b: ID tidak ada di response');

    // 7. Buat 3 adset dengan interest berbeda
    const categories = [
      { key: 'manfaat', label: 'Manfaat' },
      { key: 'perilaku', label: 'Perilaku Belanja' },
      { key: 'hobi', label: 'Hobi' }
    ];

    for (const cat of categories) {
      const catInterests = interests[cat.key] || [];

      // Kalau interest kosong → pakai broad targeting (tanpa interest), jangan skip
      const targeting = {
        age_min: 21,
        geo_locations: { countries: ['ID'] },
        targeting_automation: { advantage_audience: 0 }, // wajib di-set eksplisit oleh Meta
        ...(catInterests.length > 0
          ? { flexible_spec: [{ interests: catInterests.map(i => ({ id: i.id, name: i.name })) }] }
          : {})
      };

      // Buat adset
      const adsetRes = await fetch(`${META_API}/act_${accountId}/adsets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${camp.name} — Phase 2b ${cat.label}`,
          campaign_id: newCampaignId,
          daily_budget: 50000,
          billing_event: 'IMPRESSIONS',
          optimization_goal: optimizationGoal,
          bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
          status: 'ACTIVE',
          targeting,
          ...(promotedObject ? { promoted_object: promotedObject } : {}),
          access_token: token
        })
      });
      const adsetData = await adsetRes.json();
      if (adsetData.error) {
        const e = adsetData.error;
        const errMsg = `Adset ${cat.label}: ` + (e.error_user_msg || e.message) + ` (code: ${e.code})`;
        throw new Error(errMsg); // langsung throw supaya kelihatan di toast
      }
      const newAdsetId = adsetData.id;
      if (!newAdsetId) {
        throw new Error(`Adset ${cat.label}: Meta tidak return ID — ${JSON.stringify(adsetData)}`);
      }
      // Buat ad dengan creative yang sama dari Phase 1
      if (creativeId) {
        await fetch(`${META_API}/act_${accountId}/ads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `${camp.name} — Phase 2b ${cat.label}`,
            adset_id: newAdsetId,
            creative: { creative_id: creativeId },
            status: 'ACTIVE',
            access_token: token
          })
        });
      }

      // Simpan ke Supabase (1 row per adset)
      await sb.from('campaigns').insert({
        user_id: camp.user_id,
        ad_account_id: camp.ad_account_id,
        name: `${camp.name} — Phase 2b ${cat.label}`,
        status: 'ACTIVE',
        current_phase: 2,
        phase_type: '2b',
        phase_started_at: new Date().toISOString(),
        autopilot_enabled: true,
        product_id: camp.product_id,
        daily_budget: 50000,
        meta_campaign_id: newCampaignId,
        meta_adset_id: newAdsetId,
        days_running: 0
      });
    }

    const logEntry = {
      user_id: camp.user_id,
      campaign_name: camp.name + ' — Phase 2b',
      action_type: 'create',
      description: `Kampanye Phase 2b dibuat — 3 adset (Manfaat, Perilaku, Hobi) @ Rp 50.000/adset`,
      status: 'success'
    };
    await sb.from('action_logs').insert(logEntry);
    logs.push(logEntry);

  } catch (err) {
    console.error('createPhase2bCampaign error:', err.message);
    try { await sb.from('action_logs').insert({
      user_id: camp.user_id,
      campaign_name: camp.name,
      action_type: 'create',
      description: `Gagal buat kampanye Phase 2b: ${err.message}`,
      status: 'error'
    }); } catch(e) {}
    throw err; // propagate ke caller
  }
}

// ── Generate keyword interest per kategori via Claude ──
async function generateInterestKeywords(product) {
  const fallback = {
    manfaat: product?.name ? [product.name, ...product.name.split(/\s+/).filter(w => w.length > 2)] : [],
    perilaku: ['Online shopping', 'E-commerce', 'Shopee', 'Tokopedia', 'Lazada'],
    hobi: ['Health and wellness', 'Beauty', 'Fashion', 'Lifestyle']
  };

  if (!product) return fallback;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: `You are a Meta Ads expert for Indonesia. Based on the product below, generate 5 English interest keywords per category for Meta Ads interest targeting.

Product name: ${product.name}
Tagline: ${product.tagline || '-'}
Benefits: ${product.benefits || '-'}

Rules:
- "manfaat": related topics, product categories, or brands that buyers of this product would follow. Example for gray hair product: ["Hair care", "Shampoo", "Hair treatment", "Beauty", "Personal care"]
- "perilaku": online shopping platforms and behaviors. Example: ["Online shopping", "E-commerce", "Shopee", "Tokopedia", "Lazada"]
- "hobi": lifestyle or hobby interests of the target buyer. Example: ["Health and wellness", "Beauty", "Skin care", "Fashion", "Lifestyle"]

Return ONLY a JSON object, no explanation:
{"manfaat":["...","...","...","...","..."],"perilaku":["...","...","...","...","..."],"hobi":["...","...","...","...","..."]}` }]
      })
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || '{}';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return fallback;

    const parsed = JSON.parse(match[0]);
    // Tambah nama produk + tiap kata sebagai search term untuk manfaat (pola AdStudio)
    const productWords = [product.name, ...product.name.split(/\s+/).filter(w => w.length > 2)];
    return {
      manfaat: [...productWords, ...(parsed.manfaat || [])].slice(0, 8),
      perilaku: [...(parsed.perilaku || []), 'Online shopping', 'E-commerce'].slice(0, 6),
      hobi: [...(parsed.hobi || []), 'Lifestyle', 'Health and wellness'].slice(0, 6),
    };
  } catch (err) {
    console.error('generateInterestKeywords error:', err.message);
    return fallback;
  }
}

// ── Cari interest di Meta per kategori ──
async function searchInterestsPerCategory(keywords, token) {
  const result = { manfaat: [], perilaku: [], hobi: [] };

  for (const [cat, terms] of Object.entries(keywords)) {
    if (!terms?.length) continue;

    const fetches = terms.map(term =>
      fetch(`${META_API}/search?type=adinterest&q=${encodeURIComponent(term)}&limit=20&access_token=${encodeURIComponent(token)}`)
        .then(r => r.json()).catch(() => ({ data: [] }))
    );
    const results = await Promise.all(fetches);

    const seen = new Set();
    results.forEach(r => {
      (r.data || []).forEach(item => {
        if (!item.id || !item.name || seen.has(item.id)) return;
        seen.add(item.id);
        result[cat].push({ id: item.id, name: item.name, audience_size: item.audience_size || 0 });
      });
    });

    result[cat] = result[cat].sort((a, b) => b.audience_size - a.audience_size).slice(0, 8);

    // Kalau masih kosong, coba suggestion dari kategori lain yang sudah ada
    if (result[cat].length === 0) {
      const seeds = [...(result.hobi || []), ...(result.perilaku || []), ...(result.manfaat || [])].slice(0, 5);
      if (seeds.length > 0) {
        try {
          const suggRes = await fetch(
            `${META_API}/search?type=adinterestsuggestion&interest_list=${encodeURIComponent(JSON.stringify(seeds.map(i => i.name)))}&access_token=${encodeURIComponent(token)}`
          ).then(r => r.json()).catch(() => ({ data: [] }));
          (suggRes.data || []).forEach(item => {
            if (!item.id || !item.name || seen.has(item.id)) return;
            seen.add(item.id);
            result[cat].push({ id: item.id, name: item.name, audience_size: item.audience_size || 0 });
          });
          result[cat] = result[cat].sort((a, b) => b.audience_size - a.audience_size).slice(0, 8);
          console.log(`Phase 2b ${cat}: suggestion fallback → ${result[cat].length} interests`);
        } catch (e) {}
      }
    }
  }

  return result;
}

// ── Manual Advance Phase (dipanggil dari UI) ──
async function manualAdvancePhase(req, res) {
  const { campaign_id, user_id, product_id } = req.body;
  if (!campaign_id || !user_id) return res.status(400).json({ error: 'campaign_id dan user_id wajib' });

  try {
    // Kalau product_id dikirim dari frontend (kampanye lama yang belum terhubung produk), update dulu
    if (product_id) {
      await sb.from('campaigns').update({ product_id }).eq('id', campaign_id).eq('user_id', user_id);
    }

    const { data: camp } = await sb.from('campaigns')
      .select('*, products(target_cpr, target_cpr_ctwa, name, tagline, benefits)')
      .eq('id', campaign_id)
      .eq('user_id', user_id)
      .single();

    if (!camp) return res.status(404).json({ error: 'Kampanye tidak ditemukan' });
    if (camp.current_phase !== 1) return res.status(400).json({ error: 'Hanya kampanye Phase 1 yang bisa di-advance' });
    if (camp.initial_budget) return res.status(400).json({ error: 'Phase 2 sudah pernah dibuat untuk kampanye ini' });

    const { data: config } = await sb.from('app_config')
      .select('meta_token').eq('user_id', user_id).single();
    const token = config?.meta_token || process.env.META_ACCESS_TOKEN;
    if (!token) return res.status(400).json({ error: 'Token Meta belum dikonfigurasi' });

    const logs = [];

    // Ambil data produk untuk Phase 2b
    const product = camp.products || null;

    // Buat Phase 2a dan Phase 2b dulu — baru set initial_budget kalau keduanya sukses
    await createPhase2Campaign(camp, token, logs);
    await createPhase2bCampaign(camp, token, product, logs);

    // Simpan initial_budget setelah kedua phase berhasil dibuat
    await sb.from('campaigns').update({ initial_budget: camp.daily_budget }).eq('id', camp.id);

    await sb.from('action_logs').insert({
      user_id,
      campaign_name: camp.name,
      action_type: 'phase_advance',
      description: `"${camp.name}" di-advance manual ke Phase 2 oleh user`,
      status: 'success'
    });

    return res.status(200).json({ success: true, message: 'Phase 2 berhasil dibuat', logs });
  } catch (err) {
    console.error('manualAdvancePhase error:', err.message);
    return res.status(500).json({ error: err.message });
  }
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
    try { await sb.from('action_logs').insert(logEntry); } catch(e) {}
  }
}

async function sendWASummary(count, logs) {
  try {
    // Ambil fonnte token dari admin (role admin/superadmin) atau env var fallback
    let fonnteToken = process.env.FONNTE_TOKEN;
    if (!fonnteToken) {
      const { data: adminConfig } = await sb.from('app_config')
        .select('fonnte_token, user_id')
        .not('fonnte_token', 'is', null)
        .limit(1)
        .single();
      fonnteToken = adminConfig?.fonnte_token;
    }
    if (!fonnteToken) return; // tidak ada fonnte token sama sekali

    // Kelompokkan logs per user_id
    const byUser = {};
    for (const log of logs) {
      if (!log.user_id || log.status === 'error') continue;
      if (!byUser[log.user_id]) byUser[log.user_id] = [];
      byUser[log.user_id].push(log);
    }

    for (const [userId, userLogs] of Object.entries(byUser)) {
      // Ambil wa_target + notif settings per user (fonnte token dari admin)
      const [{ data: config }, { data: notif }] = await Promise.all([
        sb.from('app_config').select('wa_target').eq('user_id', userId).single(),
        sb.from('notif_settings').select('*').eq('user_id', userId).maybeSingle()
      ]);

      if (!config?.wa_target) continue;

      // Filter logs berdasarkan notif_settings (default semua aktif kalau belum diset)
      const filteredLogs = userLogs.filter(log => {
        if (!notif) return true; // belum ada setting = semua aktif
        switch (log.action_type) {
          case 'pause':          return notif.notif_pause !== false;
          case 'increase_budget': return notif.notif_scale !== false || notif.notif_budget !== false;
          case 'decrease_budget': return notif.notif_budget !== false;
          case 'create':         return notif.notif_create !== false;
          case 'phase_advance':  return notif.notif_winner !== false;
          default: return true;
        }
      });

      if (!filteredLogs.length) continue;

      // Kelompokkan per kampanye untuk format yang rapi
      const byCampaign = {};
      for (const log of filteredLogs) {
        const key = log.campaign_name || 'Unknown';
        if (!byCampaign[key]) byCampaign[key] = [];
        byCampaign[key].push(log);
      }

      // Emoji per action type
      const actionEmoji = {
        pause: '⏸️',
        increase_budget: '📈',
        decrease_budget: '📉',
        create: '🚀',
        phase_advance: '🏆',
        phase_hold: 'ℹ️'
      };

      const now = new Date().toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
      });

      let lines = [`🤖 *Adsy Autopilot*`, `📅 ${now} WIB`, ``];

      for (const [campName, campLogs] of Object.entries(byCampaign)) {
        lines.push(`*${campName}*`);
        for (const log of campLogs) {
          const emoji = actionEmoji[log.action_type] || '▸';
          // Ambil bagian penting dari description (potong nama kampanye di awal)
          const desc = log.description?.replace(/^"[^"]*"\s*/, '') || log.action_type;
          lines.push(`  ${emoji} ${desc}`);
        }
        lines.push('');
      }

      lines.push(`_Total ${filteredLogs.length} aksi • Cek dashboard untuk detail_`);

      const message = lines.join('\n');

      await fetch('https://api.fonnte.com/send', {
        method: 'POST',
        headers: { 'Authorization': fonnteToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: config.wa_target, message })
      });
    }
  } catch (err) {
    console.error('WA summary error:', err.message);
  }
}

// ── Cek status billing semua ad account, notif WA kalau bermasalah ──
async function checkAdAccountStatuses() {
  try {
    // Ambil semua ad account unik per user
    const { data: accounts } = await sb.from('ad_accounts').select('user_id, ad_account_id');
    if (!accounts?.length) return;

    // Deduplikasi per user + ad_account
    const pairs = [...new Map(accounts.map(a => [`${a.user_id}|${a.ad_account_id}`, a])).values()];

    const STATUS_LABEL = {
      2: 'DISABLED ❌ — akun dinonaktifkan',
      3: 'UNSETTLED ⚠️ — tagihan belum dibayar',
      7: 'PENDING REVIEW 🔍 — sedang direview Meta',
      9: 'IN GRACE PERIOD 🕐 — masa tenggang, segera bayar',
    };

    for (const { user_id, ad_account_id } of pairs) {
      try {
        const { data: config } = await sb.from('app_config')
          .select('meta_token, fonnte_token, wa_number').eq('user_id', user_id).single();
        const token = config?.meta_token || process.env.META_ACCESS_TOKEN;
        if (!token) continue;

        // Cek status akun ke Meta
        const r = await fetch(
          `${META_API}/${ad_account_id}?fields=account_status,name,currency&access_token=${encodeURIComponent(token)}`
        );
        const data = await r.json();
        if (data.error || data.account_status === 1) continue; // 1 = ACTIVE, aman

        const statusText = STATUS_LABEL[data.account_status] || `STATUS ${data.account_status}`;
        const accName = data.name || ad_account_id;

        // Cek apakah sudah pernah notif dalam 6 jam terakhir (hindari spam)
        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
        const { data: recentLog } = await sb.from('action_logs')
          .select('id').eq('user_id', user_id).eq('action_type', 'billing_alert')
          .eq('campaign_name', ad_account_id).gte('created_at', sixHoursAgo).maybeSingle();
        if (recentLog) continue; // Sudah dinotif, skip

        const message = `⚠️ *Adsy Autopilot — Billing Alert*\n\nAd Account *${accName}* bermasalah:\n*${statusText}*\n\nIklan kemungkinan sudah berhenti atau akan segera berhenti.\n\n👉 Segera cek di:\nbusiness.facebook.com → Billing & Payments`;

        // Kirim WA ke user
        if (config?.fonnte_token && config?.wa_number) {
          await fetch('https://api.fonnte.com/send', {
            method: 'POST',
            headers: { 'Authorization': config.fonnte_token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: config.wa_number, message })
          });
        }

        // Kirim WA ke admin (kalau beda dari user)
        const { data: admins } = await sb.from('profiles')
          .select('id').in('role', ['admin', 'superadmin']).neq('id', user_id);
        for (const admin of (admins || [])) {
          const { data: adminCfg } = await sb.from('app_config')
            .select('fonnte_token, wa_number').eq('user_id', admin.id).single();
          if (adminCfg?.fonnte_token && adminCfg?.wa_number) {
            await fetch('https://api.fonnte.com/send', {
              method: 'POST',
              headers: { 'Authorization': adminCfg.fonnte_token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ target: adminCfg.wa_number, message: `[Info Admin]\n${message}` })
            });
          }
        }

        // Simpan ke action_logs sebagai billing_alert
        await sb.from('action_logs').insert({
          user_id,
          campaign_name: ad_account_id,
          action_type: 'billing_alert',
          description: `Ad Account ${accName}: ${statusText}`,
          status: 'success'
        });

      } catch (e) {
        console.error('checkAdAccountStatuses error:', ad_account_id, e.message);
      }
    }
  } catch (e) {
    console.error('checkAdAccountStatuses fatal:', e.message);
  }
}
