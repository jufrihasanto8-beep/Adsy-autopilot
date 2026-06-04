// api/global-settings.js — GET/POST pengaturan global iklan (admin only)
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const { data, error } = await sb.from('global_settings').select('*').eq('id', SETTINGS_ID).single();
    if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
    return res.status(200).json(data || {
      id: SETTINGS_ID,
      ad_location_mode: 'ID_ALL',
      ad_custom_location_json: null,
      ad_placement_mode: 'AUTO',
      ad_manual_placements: null
    });
  }

  if (req.method === 'POST') {
    const { ad_location_mode, ad_custom_location_json, ad_placement_mode, ad_manual_placements } = req.body;
    const { error } = await sb.from('global_settings').upsert({
      id: SETTINGS_ID,
      ad_location_mode,
      ad_custom_location_json,
      ad_placement_mode,
      ad_manual_placements,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
