/* ============================================================================
   SUPABASE CONFIGURATION — edit this file only. Never touch index.html.

   1. Create a free project at https://supabase.com
   2. In the Supabase dashboard, run the SQL in supabase_setup.sql once
      (SQL Editor -> New query -> paste -> Run). This creates the table
      that holds the shared bills data and loads in the data that is
      already on the site today.
   3. In the dashboard go to Settings -> API and copy:
        - "Project URL"      -> paste below as SUPABASE_URL
        - "anon public" key  -> paste below as SUPABASE_ANON_KEY
   4. Save this file and re-upload it (or just edit it directly in your
      GitHub repo). No rebuild step, no other file needs to change.

   You do NOT need to touch SUPABASE_TABLE or SUPABASE_ROW_ID unless you
   changed the table/row name in supabase_setup.sql.
   ============================================================================ */
const SUPABASE_URL = 'YOUR_SUPABASE_PROJECT_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
const SUPABASE_TABLE = 'bills_state';
const SUPABASE_ROW_ID = 'main';
