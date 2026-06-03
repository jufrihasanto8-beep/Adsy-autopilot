// api/config.js — Serve public config ke frontend
// Anon key aman di-expose ke client (by design dari Supabase)
export default function handler(req, res) {
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_ANON_KEY
  });
}
