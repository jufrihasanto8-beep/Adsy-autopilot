// js/supabase.js — Init Supabase dari env via /api/config
let _sb = null;

export async function getSupabase() {
  if (_sb) return _sb;

  const res = await fetch('/api/config');
  const { supabaseUrl, supabaseKey } = await res.json();

  const { createClient } = supabase;
  _sb = createClient(supabaseUrl, supabaseKey);
  return _sb;
}
