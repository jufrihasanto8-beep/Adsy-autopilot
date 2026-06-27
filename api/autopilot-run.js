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

  // ── Retry sub-phase yang belum terbuat (Phase 2b, 2c, dst) ──
  if (req.method === 'POST' && req.body?.action === 'retry_subphase') {
    return await retryMissingSubPhase(req, res);
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
    // LOCK dulu sebelum create — cegah cron berikutnya bikin Phase 2 dobel kalau creation gagal
    await sb.from('campaigns').update({ initial_budget: camp.daily_budget }).eq('id', camp.id);

    // Ambil data produk untuk Phase 2b interest
    const { data: product } = await sb.from('products')
      .select('name, tagline, benefits')
      .eq('id', camp.product_id).single();

    // Fetch blueprint config, lalu buat Phase 2 sesuai blueprint
    const blueprintConfig = await fetchBlueprintConfig(camp.blueprint_id);
    try {
      await createPhase2FromBlueprint(camp, token, product, blueprintConfig, logs);
    } catch (createErr) {
      await sb.from('action_logs').insert({
        user_id: camp.user_id, campaign_name: camp.name, action_type: 'create',
        description: `Gagal buat Phase 2 (cron): ${createErr.message}`,
        status: 'error'
      });
      return; // lock tetap tersimpan, tidak retry otomatis — user bisa manual advance
    }

    const subPhaseCount = Array.isArray(blueprintConfig?.phase2) ? blueprintConfig.phase2.length : 2;
    const logEntry = {
      user_id: camp.user_id,
      campaign_name: camp.name,
      action_type: 'phase_advance',
      description: `"${camp.name}" lolos Phase 1 → ${subPhaseCount} sub-phase Phase 2 dibuat`,
      status: 'success'
    };
    await sb.from('action_logs').insert(logEntry);
    logs.push(logEntry);
  }

  // Phase 3 belum diimplementasi — akan ditambahkan nanti
}

// ── Buat kampanye Phase 2a di Meta (build from scratch, bukan deep copy) ──
// Deep copy tidak bisa ganti bid_strategy & budget type → buat baru ambil creative dari Phase 1
async function createPhase2Campaign(camp, token, logs, subPhaseConfig = {}, label = 'a') {
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

    // 4. Hitung bid amount COST_CAP dari blueprint config
    //    bid_pct = % naik/turun dari CPR Phase 1 (default +10%)
    const targetCpr = camp.products?.target_cpr;
    const baseCpr = camp.cpr || targetCpr;
    const bidPct = subPhaseConfig.bid_pct ?? 10;
    const bidAmount = baseCpr ? Math.round(baseCpr * (1 + bidPct / 100)) : null;
    const p2aBudget = subPhaseConfig.budget ?? 5000000;

    // 5. Buat campaign CBO + Cost Cap di level kampanye
    const campBody = {
      name: `${camp.name} — Phase 2${label.toUpperCase()}`,
      objective,
      status: 'PAUSED',
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
      daily_budget: p2aBudget,
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
      description: `Kampanye Phase 2${label.toUpperCase()} (Cost Cap) dibuat — Budget Rp ${p2aBudget.toLocaleString('id-ID')}, Bid Cap Rp ${bidAmount ? bidAmount.toLocaleString('id-ID') : '(auto)'}`,
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
async function createPhase2bCampaign(camp, token, product, logs, subPhaseConfig = {}, label = 'b') {
  if (!token || !camp.meta_campaign_id) return;

  try {
    // 1. Ambil account_id + objective dari kampanye Phase 1
    const campInfoRes = await fetch(
      `${META_API}/${camp.meta_campaign_id}?fields=account_id,objective&access_token=${encodeURIComponent(token)}`
    );
    const campInfo = await campInfoRes.json();
    if (campInfo.error) throw new Error('Gagal ambil info kampanye: ' + campInfo.error.message);
    // Normalize accountId: strip 'act_' prefix karena semua fetch di fungsi ini pakai /act_${accountId}/
    const rawAccId = campInfo.account_id;
    if (!rawAccId) throw new Error('Tidak bisa ambil account_id');
    const accountId = rawAccId.startsWith('act_') ? rawAccId.slice(4) : rawAccId;
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

    // 4. Tentukan adset groups berdasarkan strategy
    const isCBO = subPhaseConfig.strategy === 'cbo_interest';
    const phaseLabel = label.toUpperCase();

    let adsetGroups = []; // [{ label, interests: [{id,name},...] }]

    if (isCBO) {
      // CBO: auto-generate 3 varied groups (Manfaat, Lifestyle, Perilaku) — skema AdStudio
      adsetGroups = await generateCBOInterestGroups(product, token);
    } else {
      // ABO: pakai blueprint adset labels, generate keywords per label
      const blueprintAdsets = subPhaseConfig.adsets?.length
        ? subPhaseConfig.adsets
        : [{ label: 'Manfaat', type: 'interest' }, { label: 'Perilaku Belanja', type: 'interest' }, { label: 'Hobi', type: 'interest' }];
      const adsetLabelsList = blueprintAdsets.map(a => a.label || 'Interest');
      const keywords = await generateInterestKeywords(product, adsetLabelsList);
      const interests = await searchInterestsPerCategory(keywords, token);
      adsetGroups = blueprintAdsets.map(a => ({
        label: a.label || 'Interest',
        interests: interests[a.label || 'Interest'] || []
      }));
    }

    // Log interests yang ditemukan
    const interestSummary = adsetGroups.map(g => `${g.label}: ${g.interests.length} (${g.interests.slice(0,2).map(i=>i.name).join(', ')})`).join(' | ');
    console.log('Phase 2b interests found:', interestSummary);
    try { await sb.from('action_logs').insert({
      user_id: camp.user_id, campaign_name: camp.name, action_type: 'create',
      description: `Phase 2${phaseLabel} interests: ${interestSummary || 'semua kosong — pakai broad targeting'}`,
      status: 'info'
    }); } catch(e) {}

    // 6. Buat campaign — CBO (budget di campaign) atau ABO (budget di adset)

    const campPayload = {
      name: `${camp.name} — Phase 2${phaseLabel}`,
      objective,
      status: 'ACTIVE',
      special_ad_categories: [],
      access_token: token
    };
    if (isCBO) {
      // CBO: budget total di campaign level, Meta distribusi sendiri ke adsets
      campPayload.daily_budget = subPhaseConfig.budget ?? 200000;
    } else {
      // ABO: tidak ada budget di campaign, tiap adset punya budget sendiri
      campPayload.is_adset_budget_sharing_enabled = false;
    }

    const newCampRes = await fetch(`${META_API}/act_${accountId}/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(campPayload)
    });
    const newCampData = await newCampRes.json();
    if (newCampData.error) {
      const e = newCampData.error;
      throw new Error('Gagal buat campaign 2b: ' + (e.error_user_msg || e.message) + ` (code: ${e.code})`);
    }
    const newCampaignId = newCampData.id;
    if (!newCampaignId) throw new Error('Gagal buat campaign 2b: ID tidak ada di response');

    const budgetPerAdset = subPhaseConfig.budget_per_adset ?? 50000;
    // Untuk display di Supabase: CBO → bagi budget ke jumlah adset, ABO → per adset budget
    const totalCBOBudget = subPhaseConfig.budget ?? 200000;
    const dbBudgetPerRow = isCBO
      ? Math.round(totalCBOBudget / Math.max(adsetGroups.length, 1))
      : budgetPerAdset;

    for (const adsetGroup of adsetGroups) {
      const catLabel = adsetGroup.label;
      const catInterests = adsetGroup.interests || [];

      // Kalau interest kosong → pakai broad targeting (tanpa interest), jangan skip
      const targeting = {
        age_min: 21,
        geo_locations: { countries: ['ID'] },
        targeting_automation: { advantage_audience: 0 },
        ...(catInterests.length > 0
          ? { flexible_spec: [{ interests: catInterests.map(i => ({ id: i.id, name: i.name })) }] }
          : {})
      };

      // Buat adset
      const adsetBody = {
        name: `${camp.name} — Phase 2${phaseLabel} ${catLabel}`,
        campaign_id: newCampaignId,
        billing_event: 'IMPRESSIONS',
        optimization_goal: optimizationGoal,
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        status: 'ACTIVE',
        targeting,
        ...(promotedObject ? { promoted_object: promotedObject } : {}),
        access_token: token
      };
      if (!isCBO) {
        // ABO: budget di tiap adset
        adsetBody.daily_budget = budgetPerAdset;
      }
      // CBO: tidak set daily_budget di adset, Meta yg distribute

      const adsetRes = await fetch(`${META_API}/act_${accountId}/adsets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(adsetBody)
      });
      const adsetData = await adsetRes.json();
      if (adsetData.error) {
        const e = adsetData.error;
        const errMsg = `Adset ${catLabel}: ` + (e.error_user_msg || e.message) + ` (code: ${e.code})`;
        throw new Error(errMsg);
      }
      const newAdsetId = adsetData.id;
      if (!newAdsetId) {
        throw new Error(`Adset ${catLabel}: Meta tidak return ID — ${JSON.stringify(adsetData)}`);
      }
      // Buat ad dengan creative yang sama dari Phase 1
      if (creativeId) {
        await fetch(`${META_API}/act_${accountId}/ads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `${camp.name} — Phase 2${phaseLabel} ${catLabel}`,
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
        name: `${camp.name} — Phase 2${phaseLabel} ${catLabel}`,
        status: 'ACTIVE',
        current_phase: 2,
        phase_type: '2b',
        phase_started_at: new Date().toISOString(),
        autopilot_enabled: true,
        product_id: camp.product_id,
        daily_budget: dbBudgetPerRow,
        meta_campaign_id: newCampaignId,
        meta_adset_id: newAdsetId,
        days_running: 0
      });
    }

    const logEntry = {
      user_id: camp.user_id,
      campaign_name: camp.name + ' — Phase 2b',
      action_type: 'create',
      description: `Kampanye Phase 2${phaseLabel} (${isCBO ? 'CBO' : 'ABO'} Interest) dibuat — ${adsetGroups.length} adset`,
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
async function generateInterestKeywords(product, labels = ['manfaat', 'perilaku', 'hobi']) {
  // Build fallback per label
  const fallback = {};
  for (const label of labels) {
    const ll = label.toLowerCase();
    if (ll === 'manfaat' || ll.includes('manfaat') || ll.includes('produk')) {
      fallback[label] = product?.name ? [product.name, ...product.name.split(/\s+/).filter(w => w.length > 2)] : [];
    } else if (ll === 'perilaku' || ll.includes('perilaku') || ll.includes('belanja')) {
      fallback[label] = ['Online shopping', 'E-commerce', 'Shopee', 'Tokopedia', 'Lazada'];
    } else if (ll === 'hobi' || ll.includes('hobi') || ll.includes('lifestyle')) {
      fallback[label] = ['Health and wellness', 'Beauty', 'Fashion', 'Lifestyle'];
    } else {
      // Label custom (Interest 1, Audience Muda, dll) → fallback generic
      fallback[label] = product?.name ? [product.name, 'Online shopping', 'E-commerce', 'Health', 'Lifestyle'] : ['Online shopping', 'E-commerce', 'Health'];
    }
  }

  if (!product) return fallback;

  try {
    // Build deskripsi per label untuk prompt AI
    const labelsDesc = labels.map(l => {
      const ll = l.toLowerCase();
      if (ll === 'manfaat' || ll.includes('manfaat')) return `- "${l}": topik/kategori/merek terkait produk (misal untuk produk rambut: Hair care, Shampoo, dll)`;
      if (ll === 'perilaku' || ll.includes('perilaku') || ll.includes('belanja')) return `- "${l}": platform belanja online dan perilaku belanja`;
      if (ll === 'hobi' || ll.includes('hobi')) return `- "${l}": minat/hobi gaya hidup dari pembeli target`;
      return `- "${l}": interest keyword yang relevan untuk orang yang tertarik dengan "${l}" dan berpotensi beli produk ini`;
    }).join('\n');

    const expectedJson = '{' + labels.map(l => `"${l}":["...","...","...","...","..."]`).join(',') + '}';

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{ role: 'user', content: `You are a Meta Ads expert for Indonesia. Based on the product below, generate 5 English interest keywords per category for Meta Ads interest targeting.

Product name: ${product.name}
Tagline: ${product.tagline || '-'}
Benefits: ${product.benefits || '-'}

Categories (generate 5 keywords each):
${labelsDesc}

Return ONLY a JSON object with EXACT category names as keys, no explanation:
${expectedJson}` }]
      })
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || '{}';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return fallback;

    const parsed = JSON.parse(match[0]);
    const result = {};
    const productWords = product.name ? [product.name, ...product.name.split(/\s+/).filter(w => w.length > 2)] : [];

    for (const label of labels) {
      const ll = label.toLowerCase();
      // Coba exact match dulu, lalu lowercase match
      const kwList = parsed[label] || parsed[ll] || [];
      if (ll === 'manfaat' || ll.includes('manfaat') || ll.includes('produk')) {
        result[label] = [...productWords, ...kwList].slice(0, 8);
      } else if (ll === 'perilaku' || ll.includes('perilaku') || ll.includes('belanja')) {
        result[label] = [...kwList, 'Online shopping', 'E-commerce'].slice(0, 6);
      } else if (ll === 'hobi' || ll.includes('hobi')) {
        result[label] = [...kwList, 'Lifestyle', 'Health and wellness'].slice(0, 6);
      } else {
        // Custom label
        result[label] = kwList.length > 0 ? kwList.slice(0, 6) : fallback[label];
      }
    }
    return result;
  } catch (err) {
    console.error('generateInterestKeywords error:', err.message);
    return fallback;
  }
}

// ── Cari interest di Meta per kategori ──
// ── CBO Interest: auto-generate 3 varied interest groups (skema AdStudio) ──
async function generateCBOInterestGroups(product, token) {
  const productName = product?.name || 'produk';
  const junk = [/akses facebook/i, /perangkat seluler/i, /perangkat android/i, /perangkat ios/i, /ulang tahun/i, /administrator halaman/i];

  // Step 1: Claude generate 30 diverse behavior/lifestyle terms untuk produk ini
  let extraTerms = [];
  try {
    const termRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{ role: 'user', content: `Produk: "${productName}". Tagline: ${product?.tagline||'-'}. Manfaat: ${product?.benefits||'-'}.

Berikan 30 kata kunci campuran Indonesia+Inggris untuk cari interest di Meta Ads.
Pikirkan KONKRET: apa yang dipakai, tempat yang dikunjungi, hobi, gaya hidup, kebiasaan belanja pembeli "${productName}".
HANYA array JSON: ["kata1","kata2",...]` }]
      })
    });
    const termData = await termRes.json();
    const termText = termData.content?.[0]?.text || '[]';
    const m = termText.match(/\[[\s\S]*\]/);
    if (m) extraTerms = JSON.parse(m[0]);
  } catch (e) { console.error('CBO term gen error:', e.message); }

  // Step 2: Search Meta — nama produk + semua terms (paralel)
  const productWords = [productName, ...productName.split(/\s+/).filter(w => w.length > 2)];
  const allSearchTerms = [...productWords, ...extraTerms].slice(0, 30);
  const seen = new Set();
  const metaInterests = [];

  const fetches = allSearchTerms.map(term =>
    fetch(`${META_API}/search?type=adinterest&q=${encodeURIComponent(term)}&limit=20&access_token=${encodeURIComponent(token)}`)
      .then(r => r.json()).catch(() => ({ data: [] }))
  );
  const results = await Promise.all(fetches);
  results.forEach(r => {
    (r.data || []).forEach(item => {
      if (!item.id || !item.name || seen.has(item.id)) return;
      if (junk.some(p => p.test(item.name))) return;
      seen.add(item.id);
      metaInterests.push({ id: item.id, name: item.name, audience_size: item.audience_size || 0 });
    });
  });

  // Step 3: adinterestsuggestion dari top results
  const topNames = [...metaInterests].sort((a, b) => b.audience_size - a.audience_size).slice(0, 10).map(i => i.name);
  if (topNames.length > 0) {
    try {
      const suggData = await fetch(
        `${META_API}/search?type=adinterestsuggestion&interest_list=${encodeURIComponent(JSON.stringify(topNames))}&access_token=${encodeURIComponent(token)}`
      ).then(r => r.json()).catch(() => ({ data: [] }));
      (suggData.data || []).forEach(item => {
        if (!item.id || !item.name || seen.has(item.id)) return;
        if (junk.some(p => p.test(item.name))) return;
        seen.add(item.id);
        metaInterests.push({ id: item.id, name: item.name, audience_size: item.audience_size || 0 });
      });
    } catch (e) {}
  }

  console.log(`CBO Interest: ${metaInterests.length} interests found from Meta`);

  // Fallback kalau Meta kosong
  if (metaInterests.length === 0) {
    return [
      { label: 'Manfaat', interests: [] },
      { label: 'Lifestyle', interests: [] },
      { label: 'Perilaku', interests: [] }
    ];
  }

  // Step 4: Claude kategorikan ke 3 grup (Manfaat, Lifestyle, Perilaku)
  const metaList = metaInterests.slice(0, 60)
    .map(i => `- ${i.name} (${i.audience_size ? (i.audience_size/1000000).toFixed(1)+'M' : '?'})`)
    .join('\n');

  const defaultGroups = () => {
    const sorted = [...metaInterests].sort((a, b) => b.audience_size - a.audience_size);
    return [
      { label: 'Manfaat', interests: sorted.slice(0, 8) },
      { label: 'Lifestyle', interests: sorted.slice(8, 16) },
      { label: 'Perilaku', interests: sorted.slice(16, 24) }
    ];
  };

  try {
    const catRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        messages: [{ role: 'user', content: `Produk: "${productName}". Berikut ${metaInterests.length} interest dari Meta Ads:

${metaList}

Kategorikan ke 3 grup untuk targeting BERBEDA. Pilih 6-8 interest TERBAIK per grup dari list di atas:
1. "Manfaat" — interest langsung terkait produk, kategori produk, manfaat, brand sejenis
2. "Lifestyle" — gaya hidup, hobi, minat pembeli yang kemungkinan beli produk ini
3. "Perilaku" — perilaku belanja online, platform e-commerce, aktivitas pembelian

PENTING: nama interest HARUS PERSIS sama seperti di list. Return HANYA JSON:
{"Manfaat":["nama1","nama2",...],"Lifestyle":["..."],"Perilaku":["..."]}` }]
      })
    });
    const catData = await catRes.json();
    const catText = catData.content?.[0]?.text || '{}';
    const catMatch = catText.match(/\{[\s\S]*\}/);
    if (!catMatch) return defaultGroups();

    const categorized = JSON.parse(catMatch[0]);
    const nameToInterest = {};
    metaInterests.forEach(i => { nameToInterest[i.name] = i; });

    const groups = ['Manfaat', 'Lifestyle', 'Perilaku'].map(groupName => ({
      label: groupName,
      interests: (categorized[groupName] || [])
        .map(name => nameToInterest[name])
        .filter(Boolean)
        .slice(0, 8)
    }));

    // Pastikan semua grup ada interests (fallback ke default kalau Claude return kosong)
    const total = groups.reduce((s, g) => s + g.interests.length, 0);
    return total > 0 ? groups : defaultGroups();

  } catch (e) {
    console.error('CBO categorize error:', e.message);
    return defaultGroups();
  }
}

async function searchInterestsPerCategory(keywords, token) {
  // Init result dinamis sesuai labels yang dikirim (support label apapun)
  const result = {};
  for (const key of Object.keys(keywords)) result[key] = [];

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

    // Fetch blueprint config, buat Phase 2 sesuai blueprint
    const blueprintConfig = await fetchBlueprintConfig(camp.blueprint_id);

    // LOCK dulu sebelum create — cegah dobel kalau user klik 2× atau cron jalan bersamaan
    await sb.from('campaigns').update({ initial_budget: camp.daily_budget }).eq('id', camp.id);

    await createPhase2FromBlueprint(camp, token, product, blueprintConfig, logs);

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

// ── Fetch blueprint config dari Supabase ──
async function fetchBlueprintConfig(blueprintId) {
  if (!blueprintId) return null;
  const { data } = await sb.from('autopilot_blueprints').select('config').eq('id', blueprintId).single();
  return data?.config || null;
}

// ── Dispatcher Phase 2: baca blueprint, buat sub-phase sesuai urutan ──
async function createPhase2FromBlueprint(camp, token, product, blueprintConfig, logs) {
  // Normalize phase2: new array format, old single-strategy, or fallback default
  let subPhases = [];
  const p2 = blueprintConfig?.phase2;
  if (Array.isArray(p2) && p2.length) {
    subPhases = p2;
  } else if (p2?.strategy) {
    // old single-strategy format
    const s = p2.strategy;
    if (s === 'cost_cap_abo' || s === 'cost_cap_only') subPhases.push({ strategy: 'cost_cap', budget: p2.cost_cap?.budget, bid_pct: p2.cost_cap?.bid_multiplier ? Math.round((p2.cost_cap.bid_multiplier - 1) * 100) : 10 });
    if (s === 'cost_cap_abo' || s === 'abo_interest') subPhases.push({ strategy: 'abo_interest', adsets: p2.abo?.adsets, budget_per_adset: p2.abo?.budget_per_adset });
    if (s === 'lookalike') subPhases.push({ strategy: 'lookalike', budget: p2.simple?.budget });
    if (s === 'broad') subPhases.push({ strategy: 'broad', budget: p2.simple?.budget });
  } else if (blueprintConfig?.phase2a || blueprintConfig?.phase2b) {
    // legacy format
    if (blueprintConfig.phase2a?.enabled !== false) subPhases.push({ strategy: 'cost_cap', budget: blueprintConfig.phase2a?.budget, bid_pct: Math.round(((blueprintConfig.phase2a?.bid_multiplier ?? 1.1) - 1) * 100) });
    if (blueprintConfig.phase2b?.enabled !== false) subPhases.push({ strategy: 'abo_interest', adsets: blueprintConfig.phase2b?.adsets, budget_per_adset: blueprintConfig.phase2b?.budget_per_adset });
  } else {
    // No blueprint / blueprint tanpa phase2 → default standard
    subPhases = [{ strategy: 'cost_cap' }, { strategy: 'abo_interest' }];
  }

  for (let idx = 0; idx < subPhases.length; idx++) {
    const sp = subPhases[idx];
    const label = String.fromCharCode(97 + idx); // a, b, c...
    try {
      if (sp.strategy === 'cost_cap') {
        await createPhase2Campaign(camp, token, logs, sp, label);
      } else if (sp.strategy === 'abo_interest' || sp.strategy === 'cbo_interest') {
        await createPhase2bCampaign(camp, token, product, logs, sp, label);
      }
      // lookalike / broad → placeholder, will be implemented later
    } catch (subErr) {
      console.error(`Phase 2${label.toUpperCase()} creation failed:`, subErr.message);
      try { await sb.from('action_logs').insert({
        user_id: camp.user_id, campaign_name: camp.name, action_type: 'create',
        description: `Sub-phase 2${label.toUpperCase()} gagal: ${subErr.message} — klik Retry 2b di campaigns untuk coba lagi`,
        status: 'error'
      }); } catch(e) {}
      // Lanjut ke sub-phase berikutnya meski satu gagal
    }
  }
}

// ── Retry sub-phase yang belum terbuat (Phase 2b, 2c, dst) ──
async function retryMissingSubPhase(req, res) {
  const { campaign_id, user_id } = req.body;
  if (!campaign_id || !user_id) return res.status(400).json({ error: 'campaign_id dan user_id wajib' });

  try {
    const { data: camp } = await sb.from('campaigns')
      .select('*, products(target_cpr, target_cpr_ctwa, name, tagline, benefits)')
      .eq('id', campaign_id)
      .eq('user_id', user_id)
      .single();

    if (!camp) return res.status(404).json({ error: 'Kampanye tidak ditemukan' });
    if (!camp.initial_budget) return res.status(400).json({ error: 'Phase 2 belum pernah dimulai untuk kampanye ini' });

    const { data: config } = await sb.from('app_config')
      .select('meta_token').eq('user_id', user_id).single();
    const token = config?.meta_token || process.env.META_ACCESS_TOKEN;
    if (!token) return res.status(400).json({ error: 'Token Meta belum dikonfigurasi' });

    // Cek sub-phase mana yang sudah ada di DB
    const { data: existingPhase2 } = await sb.from('campaigns')
      .select('name')
      .ilike('name', camp.name + ' — Phase 2%');

    const existingLabels = new Set();
    (existingPhase2 || []).forEach(c => {
      // Extract label: "...— Phase 2a" → 'a', "...— Phase 2B Manfaat" → 'b'
      const match = c.name.replace(camp.name, '').match(/— Phase 2([a-zA-Z])/);
      if (match) existingLabels.add(match[1].toLowerCase());
    });

    // Normalize sub-phases dari blueprint
    const blueprintConfig = await fetchBlueprintConfig(camp.blueprint_id);
    let subPhases = [];
    const p2 = blueprintConfig?.phase2;
    if (Array.isArray(p2) && p2.length) {
      subPhases = p2;
    } else if (blueprintConfig?.phase2a || blueprintConfig?.phase2b) {
      if (blueprintConfig.phase2a?.enabled !== false) subPhases.push({ strategy: 'cost_cap' });
      if (blueprintConfig.phase2b?.enabled !== false) subPhases.push({ strategy: 'abo_interest' });
    } else {
      subPhases = [{ strategy: 'cost_cap' }, { strategy: 'abo_interest' }];
    }

    const product = camp.products || null;
    const logs = [];
    let created = 0;
    let errors = [];

    for (let idx = 0; idx < subPhases.length; idx++) {
      const label = String.fromCharCode(97 + idx);
      if (existingLabels.has(label)) continue; // sudah ada, skip

      const sp = subPhases[idx];
      try {
        if (sp.strategy === 'cost_cap') {
          await createPhase2Campaign(camp, token, logs, sp, label);
        } else if (sp.strategy === 'abo_interest' || sp.strategy === 'cbo_interest') {
          await createPhase2bCampaign(camp, token, product, logs, sp, label);
        }
        created++;
      } catch (subErr) {
        errors.push(`Phase 2${label.toUpperCase()}: ${subErr.message}`);
        try { await sb.from('action_logs').insert({
          user_id, campaign_name: camp.name, action_type: 'create',
          description: `Retry sub-phase 2${label.toUpperCase()} gagal: ${subErr.message}`,
          status: 'error'
        }); } catch(e) {}
      }
    }

    if (created > 0) {
      await sb.from('action_logs').insert({
        user_id, campaign_name: camp.name, action_type: 'phase_advance',
        description: `Retry: ${created} sub-phase Phase 2 berhasil dibuat`,
        status: 'success'
      });
    }

    return res.status(200).json({
      success: true,
      created,
      skipped: existingLabels.size,
      errors: errors.length > 0 ? errors : undefined,
      logs
    });
  } catch (err) {
    console.error('retryMissingSubPhase error:', err.message);
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
