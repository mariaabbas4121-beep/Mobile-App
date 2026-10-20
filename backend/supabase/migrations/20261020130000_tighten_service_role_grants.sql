-- Supabase's default privileges grant ALL on new public tables to
-- service_role, and 20261020120000 only revoked them from public, anon and
-- authenticated. Reduce service_role to exactly what the backend needs.
--
-- audit_events must be append-only for every role. The row trigger blocks
-- UPDATE and DELETE, but TRUNCATE bypasses row triggers, so the privilege
-- itself has to go.

revoke all on table public.audit_events from service_role;
grant select, insert on table public.audit_events to service_role;

revoke truncate, references, trigger on table public.profiles, public.user_verifications from service_role;

-- Statement-level guard: TRUNCATE is refused even for roles that still hold
-- the privilege (e.g. the table owner during maintenance).
create trigger audit_events_block_truncate
  before truncate on public.audit_events
  for each statement execute function public.audit_events_block_changes();
