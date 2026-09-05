/* ============================================================================
   SUPABASE CONFIGURATION — the only file you edit to point this page at a
   database. Never edit index.html.

   These values are meant to be public. The publishable key identifies the
   project; it grants nothing on its own. Every row in this schema is behind
   Row Level Security that requires a signed-in user whose address is listed
   in bills.allowed_emails, so a visitor holding this key and the URL still
   sees nothing.
   ============================================================================ */
const SUPABASE_URL    = 'https://tauwfxwsfwutzxlfjkhj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_mioLyVF2eF_2NuEkWa8gkQ_3CVbB2DK';

/* Where the ledger lives. These match supabase/02_bills_schema.sql — leave
   them alone unless that migration changes. */
const SUPABASE_SCHEMA = 'bills';
const SUPABASE_TABLE  = 'state';
const SUPABASE_ROW_ID = 'main';
