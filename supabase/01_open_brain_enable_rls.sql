-- ============================================================================
-- 01 — Defence in depth for the Open Brain tables
--
-- No policies are added, on purpose. Every legitimate OB entry point is a
-- SECURITY DEFINER function owned by `postgres` (rolbypassrls = true), and
-- the tables are owned by `postgres` (an owner bypasses RLS unless FORCE
-- ROW LEVEL SECURITY is set, which it is not). Enabling RLS closes the
-- direct-table path without touching the function path OB actually uses.
--
-- Verified beforehand: open_brain_agent has EXECUTE on all 14 functions and
-- ZERO table privileges, so it never reaches these tables directly.
-- ============================================================================
alter table open_brain.session_design_notes enable row level security;
alter table open_brain.classifications      enable row level security;
alter table open_brain.scopes               enable row level security;
alter table open_brain.tasks                enable row level security;
