// api/meta-insights.js — Sync performa dari Meta Ads
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const META_API = 'https://graph.facebook.com/v18.0';

export default async function handler(req, res) {
  if (req.method === 'GET' && req.query.breakdown === 'region')    return await fetchRegionBreakdown(req, res);
  if (req.method === 'GET' && req.query.breakdown === 'daily')     return await fetchDailyTrend(req, res);
  if (req.method === 'GET' && req.query.breakdown === 'demo')      return await fetchDemoBreakdown(req, res);
  if (req.method === 'GET' && req.query.breakdown === 'placement') return await fetchPlacementBreakdown(req, res);
  if (req.method === 'GET') return await fetchRangeInsights(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Get all active campaigns
    const { data: campaigns } = await sb.from('campaigns')
      .select('*, profiles(id)')
      .eq('status', 'ACTIVE')
      .not('meta_campaign_id', 'is', null);

    if (!campaigns || campaigns.length === 0) {
      return res.status(200).json({ synced: 0 });
    }

    let synced = 0;

    for (const camp of campaigns) {
      try {
        // Get user token
        const { data: config } = await sb.from('app_config')
          .select('meta_token').eq('user_id', camp.user_id).single();

        const token = config?.meta_token || process.env.META_ACCESS_TOKEN;
        if (!token) continue;

        // Fetch insights from Meta
        const fields = 'spend,clicks,impressions,ctr,cpc,actions,cost_per_action_type';
        const insightRes = await fetch(
          `${META_API}/${camp.meta_campaign_id}/insights?fields=${fields}&date_preset=today&access_token=${token}`
        );
        const insight = await insightRes.json();

        if (insight.error || !insight.data || insight.data.length === 0) continue;

        const d = insight.data[0];
        // Hitung results: purchase → lead (tidak pakai link_click)
        const results = d.actions?.find(a => a.action_type === 'offsite_conversion.fb_pixel_purchase')?.value
          || d.actions?.find(a => a.action_type === 'lead')?.value
          || 0;
        const cpr = results > 0 ? parseFloat(d.spend) / results : null;

        // Update campaign
        await sb.from('campaigns').update({
          spend_today: parseFloat(d.spend) || 0,
          clicks_today: parseInt(d.clicks) || 0,
          ctr: parseFloat(d.ctr) || null,
          cpr: cpr ? Math.round(cpr) : null,
          results_today: parseInt(results),
          last_synced: new Date().toISOString()
        }).eq('id', camp.id);

        synced++;
      } catch (e) {
        console.error(`Error syncing campaign ${camp.id}:`, e.message);
      }
    }

    return res.status(200).json({ success: true, synced });
  } catch (err) {
    console.error('meta-insights error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── GET: Fetch insights untuk range tanggal tertentu (untuk display, tidak disimpan ke DB) ──
async function fetchRangeInsights(req, res) {
  const userId = req.query.user_id;
  const datePreset = req.query.date_preset || 'today'; // today, yesterday, last_7_days, last_30_days
  if (!userId) return res.status(400).json({ error: 'user_id required' });

  const { data: config } = await sb.from('app_config').select('meta_token').eq('user_id', userId).single();
  const token = config?.meta_token || process.env.META_ACCESS_TOKEN;
  if (!token) return res.status(400).json({ error: 'Token Meta belum dikonfigurasi' });

  const { data: campaigns } = await sb.from('campaigns')
    .select('id, name, meta_campaign_id, meta_adset_id, current_phase, status, daily_budget')
    .eq('user_id', userId)
    .not('meta_campaign_id', 'is', null);

  if (!campaigns?.length) return res.status(200).json({ campaigns: [], totals: { spend: 0, results: 0 } });

  const fields = 'spend,clicks,impressions,ctr,actions';
  const results = [];
  let totalSpend = 0;
  let totalResults = 0;

  for (const camp of campaigns) {
    try {
      const targetId = camp.meta_adset_id || camp.meta_campaign_id;
      const level = camp.meta_adset_id ? 'adset' : 'campaign';
      const insightRes = await fetch(
        `${META_API}/${targetId}/insights?fields=${fields}&date_preset=${datePreset}&level=${level}&access_token=${encodeURIComponent(token)}`
      );
      const insight = await insightRes.json();

      if (insight.error || !insight.data?.length) {
        results.push({ ...camp, spend: 0, cpr: null, ctr: null, results_count: 0, impressions: 0 });
        continue;
      }

      const d = insight.data[0];
      const spend = parseFloat(d.spend || 0); // IDR langsung dari Meta
      const clicks = parseInt(d.clicks || 0);
      const impressions = parseInt(d.impressions || 0);
      const ctr = parseFloat(d.ctr || 0);

      // Hitung results: priority purchase → lead (tidak pakai link_click sebagai fallback)
      const actions = d.actions || [];
      const getAction = (...types) => {
        for (const t of types) {
          const found = actions.find(a => a.action_type === t);
          if (found) return parseInt(found.value || 0);
        }
        return 0;
      };
      const resultCount = getAction('offsite_conversion.fb_pixel_purchase', 'lead');
      const cpr = resultCount > 0 ? Math.round(spend / resultCount) : null;

      totalSpend += spend;
      totalResults += resultCount;

      results.push({ ...camp, spend, cpr, ctr, results_count: resultCount, impressions, clicks });
    } catch (e) {
      results.push({ ...camp, spend: 0, cpr: null, ctr: null, results_count: 0, impressions: 0 });
    }
  }

  return res.status(200).json({
    campaigns: results,
    totals: { spend: totalSpend, results: totalResults },
    date_preset: datePreset
  });
}

// ── GET: Fetch spend breakdown per region (provinsi) ──
async function fetchRegionBreakdown(req, res) {
  const { user_id, campaign_id, since, until } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const { data: config } = await sb.from('app_config').select('meta_token').eq('user_id', user_id).single();
  const token = config?.meta_token || process.env.META_ACCESS_TOKEN;
  if (!token) return res.status(400).json({ error: 'Token Meta belum dikonfigurasi' });

  let campaigns = [];
  if (campaign_id) {
    const { data } = await sb.from('campaigns')
      .select('id, name, meta_campaign_id')
      .eq('id', campaign_id)
      .not('meta_campaign_id', 'is', null)
      .single();
    if (data) campaigns = [data];
  } else {
    const { data } = await sb.from('campaigns')
      .select('id, name, meta_campaign_id')
      .eq('user_id', user_id)
      .not('meta_campaign_id', 'is', null);
    campaigns = data || [];
  }

  if (!campaigns.length) return res.status(200).json({ regions: [] });

  // Build time param — pakai time_range jika since/until ada
  const timeParam = (since && until)
    ? `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`
    : `date_preset=last_30_days`;

  // Fetch region breakdown per campaign in parallel
  const regionMap = {};
  await Promise.all(campaigns.map(async (camp) => {
    try {
      const fields = 'spend,impressions,clicks';
      const url = `${META_API}/${camp.meta_campaign_id}/insights?fields=${fields}&breakdowns=region&${timeParam}&access_token=${encodeURIComponent(token)}`;
      const r = await fetch(url);
      const json = await r.json();
      if (!json.data) return;
      for (const item of json.data) {
        const region = item.region || 'Lainnya';
        if (!regionMap[region]) regionMap[region] = { region, spend: 0, impressions: 0, clicks: 0 };
        regionMap[region].spend += parseFloat(item.spend || 0);
        regionMap[region].impressions += parseInt(item.impressions || 0);
        regionMap[region].clicks += parseInt(item.clicks || 0);
      }
    } catch (e) { /* skip */ }
  }));

  const regions = Object.values(regionMap).sort((a, b) => b.spend - a.spend);
  return res.status(200).json({ regions, campaign_id: campaign_id || null, since, until });
}

// ── Helper: ambil token + campaigns ──
async function getTokenAndCampaigns(user_id, campaign_id) {
  const { data: config } = await sb.from('app_config').select('meta_token').eq('user_id', user_id).single();
  const token = config?.meta_token || process.env.META_ACCESS_TOKEN;
  let campaigns = [];
  if (campaign_id) {
    const { data } = await sb.from('campaigns').select('id,name,meta_campaign_id').eq('id', campaign_id).not('meta_campaign_id','is',null).single();
    if (data) campaigns = [data];
  } else {
    const { data } = await sb.from('campaigns').select('id,name,meta_campaign_id').eq('user_id', user_id).not('meta_campaign_id','is',null);
    campaigns = data || [];
  }
  return { token, campaigns };
}

function buildTimeParam(since, until) {
  return (since && until)
    ? `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`
    : `date_preset=last_30_days`;
}

function getResults(actions) {
  return parseInt(
    (actions || []).find(a => a.action_type === 'offsite_conversion.fb_pixel_purchase')?.value ||
    (actions || []).find(a => a.action_type === 'lead')?.value || 0
  );
}

// ── GET: Trend harian spend + hasil ──
async function fetchDailyTrend(req, res) {
  const { user_id, campaign_id, since, until } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  const { token, campaigns } = await getTokenAndCampaigns(user_id, campaign_id);
  if (!token) return res.status(400).json({ error: 'Token Meta belum dikonfigurasi' });
  if (!campaigns.length) return res.status(200).json({ daily: [] });

  const timeParam = buildTimeParam(since, until);
  const dateMap = {};

  await Promise.all(campaigns.map(async (camp) => {
    try {
      const url = `${META_API}/${camp.meta_campaign_id}/insights?fields=spend,actions&time_increment=1&${timeParam}&access_token=${encodeURIComponent(token)}`;
      const json = await (await fetch(url)).json();
      if (!json.data) return;
      for (const item of json.data) {
        const d = item.date_start;
        if (!dateMap[d]) dateMap[d] = { date: d, spend: 0, results: 0 };
        dateMap[d].spend   += parseFloat(item.spend || 0);
        dateMap[d].results += getResults(item.actions);
      }
    } catch (e) {}
  }));

  const daily = Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
  return res.status(200).json({ daily });
}

// ── GET: Breakdown umur & gender ──
async function fetchDemoBreakdown(req, res) {
  const { user_id, campaign_id, since, until } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  const { token, campaigns } = await getTokenAndCampaigns(user_id, campaign_id);
  if (!token) return res.status(400).json({ error: 'Token Meta belum dikonfigurasi' });
  if (!campaigns.length) return res.status(200).json({ demo: [] });

  const timeParam = buildTimeParam(since, until);
  const demoMap = {};

  await Promise.all(campaigns.map(async (camp) => {
    try {
      const url = `${META_API}/${camp.meta_campaign_id}/insights?fields=spend,actions&breakdowns=age,gender&${timeParam}&access_token=${encodeURIComponent(token)}`;
      const json = await (await fetch(url)).json();
      if (!json.data) return;
      for (const item of json.data) {
        const key = `${item.age}__${item.gender}`;
        if (!demoMap[key]) demoMap[key] = { age: item.age, gender: item.gender, spend: 0, results: 0 };
        demoMap[key].spend   += parseFloat(item.spend || 0);
        demoMap[key].results += getResults(item.actions);
      }
    } catch (e) {}
  }));

  const demo = Object.values(demoMap).sort((a, b) => a.age.localeCompare(b.age));
  return res.status(200).json({ demo });
}

// ── GET: Breakdown placement ──
async function fetchPlacementBreakdown(req, res) {
  const { user_id, campaign_id, since, until } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  const { token, campaigns } = await getTokenAndCampaigns(user_id, campaign_id);
  if (!token) return res.status(400).json({ error: 'Token Meta belum dikonfigurasi' });
  if (!campaigns.length) return res.status(200).json({ placements: [] });

  const timeParam = buildTimeParam(since, until);
  const placeMap = {};

  await Promise.all(campaigns.map(async (camp) => {
    try {
      const url = `${META_API}/${camp.meta_campaign_id}/insights?fields=spend,impressions,actions&breakdowns=publisher_platform,platform_position&${timeParam}&access_token=${encodeURIComponent(token)}`;
      const json = await (await fetch(url)).json();
      if (!json.data) return;
      for (const item of json.data) {
        const key = `${item.publisher_platform}__${item.platform_position}`;
        if (!placeMap[key]) placeMap[key] = { platform: item.publisher_platform, position: item.platform_position, spend: 0, impressions: 0, results: 0 };
        placeMap[key].spend       += parseFloat(item.spend || 0);
        placeMap[key].impressions += parseInt(item.impressions || 0);
        placeMap[key].results     += getResults(item.actions);
      }
    } catch (e) {}
  }));

  const placements = Object.values(placeMap).sort((a, b) => b.spend - a.spend);
  return res.status(200).json({ placements });
}
