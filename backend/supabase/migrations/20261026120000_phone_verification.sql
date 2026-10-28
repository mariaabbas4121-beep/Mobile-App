-- Phone verification through Supabase Auth's phone-change OTP flow.
--
-- Supabase Auth sends and checks the OTP; nothing here stores or compares a
-- code. The API calls these functions with the secret key (service_role)
-- only after it has checked the caller's token and Supabase's own result:
--
--   phone_verification_begin     reserve an SMS send (resend cooldown)
--   phone_verification_release   undo a reservation when nothing was sent
--   phone_verification_pending   record the number a code was requested for
--   phone_verification_complete  record a number Supabase Auth has confirmed
--   phone_verification_failed    audit a rejected code
--   phone_verification_revoke    withdraw a result Supabase Auth no longer backs
--
-- Clients cannot call any of them and cannot write the new columns.

alter table public.profiles
  -- Number a code was last requested for. Not verified; never used for
  -- anything except matching the confirmation to the request.
  add column pending_phone_e164 text
    check (pending_phone_e164 is null or pending_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- When the API last asked Supabase to send this user a code. Enforces the
  -- resend cooldown across API instances.
  add column phone_otp_sent_at timestamptz;

comment on column public.profiles.pending_phone_e164 is
  'Number awaiting OTP confirmation. Written only by phone_verification_* functions.';

-- ---------------------------------------------------------------------------
-- Functions (service_role only)
-- ---------------------------------------------------------------------------

-- Reserves an SMS send for the user. Returns 0 if the caller may send now
-- (and records the time), otherwise the seconds left in the cooldown. The row
-- lock makes concurrent requests (double taps, several API instances) queue,
-- so only one of them sends.
create function public.phone_verification_begin(p_user_id uuid, p_cooldown_seconds integer)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_status public.account_status;
  v_sent_at timestamptz;
  v_remaining integer;
begin
  if p_cooldown_seconds is null or p_cooldown_seconds < 0 then
    raise exception 'invalid cooldown' using errcode = 'check_violation';
  end if;

  select account_status, phone_otp_sent_at into v_status, v_sent_at
    from public.profiles where id = p_user_id for update;

  if not found then
    raise exception 'profile not found' using errcode = 'PV404';
  end if;
  if v_status in ('suspended', 'deletion_pending') then
    raise exception 'account not in good standing' using errcode = 'PV403';
  end if;

  if v_sent_at is not null then
    v_remaining := pg_catalog.ceil(
      p_cooldown_seconds - extract(epoch from (pg_catalog.now() - v_sent_at))
    )::integer;
    if v_remaining > 0 then
      return v_remaining;
    end if;
  end if;

  update public.profiles set phone_otp_sent_at = pg_catalog.now() where id = p_user_id;
  return 0;
end;
$$;

-- Clears a reservation when the provider sent nothing, so the user can retry
-- at once.
create function public.phone_verification_release(p_user_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.profiles set phone_otp_sent_at = null where id = p_user_id;
$$;

-- Records that a code was requested for p_phone. A user who already has a
-- verified number keeps it (Supabase Auth still confirms it) until the new one
-- is confirmed; anyone else moves to `pending`.
create function public.phone_verification_pending(p_user_id uuid, p_phone text, p_resend boolean)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_status public.verification_status;
  v_id uuid;
begin
  update public.profiles set pending_phone_e164 = p_phone where id = p_user_id;
  if not found then
    raise exception 'profile not found' using errcode = 'PV404';
  end if;

  select id, status into v_id, v_status
    from public.user_verifications
   where user_id = p_user_id and verification_type = 'phone'
     for update;

  if not found then
    insert into public.user_verifications (user_id, verification_type, status, provider_name)
    values (p_user_id, 'phone', 'pending', 'supabase_auth')
    returning id into v_id;
  elsif v_status <> 'verified' then
    update public.user_verifications
       set status = 'pending', provider_name = 'supabase_auth'
     where id = v_id;
  end if;

  insert into public.audit_events (actor_user_id, event_type, entity_type, entity_id, outcome, metadata)
  values (
    p_user_id,
    case when p_resend then 'verification.phone_code_resent' else 'verification.phone_code_requested' end,
    'user_verification',
    v_id,
    'success',
    pg_catalog.jsonb_build_object('change_of_verified_number', coalesce(v_status = 'verified', false))
  );
end;
$$;

-- Records p_phone as the user's verified number. The API calls this only
-- after Supabase Auth reports this user's phone as p_phone and confirmed.
-- It refuses a number the user never requested a code for.
create function public.phone_verification_complete(p_user_id uuid, p_phone text, p_verified_at timestamptz)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_pending text;
  v_previous text;
  v_previous_verified_at timestamptz;
  v_status public.verification_status;
  v_id uuid;
  v_other uuid;
begin
  if p_verified_at is null then
    raise exception 'verified_at is required' using errcode = 'check_violation';
  end if;

  select pending_phone_e164, phone_e164, phone_verified_at
    into v_pending, v_previous, v_previous_verified_at
    from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'profile not found' using errcode = 'PV404';
  end if;
  if v_pending is distinct from p_phone then
    raise exception 'no pending verification for this number' using errcode = 'PV409';
  end if;

  -- Supabase Auth allows a phone number on one user at a time, so any other
  -- profile still claiming this number as verified is stale (that user has
  -- since changed number in Auth). Withdraw it so the unique index holds.
  for v_other in
    update public.profiles
       set phone_verified_at = null
     where phone_e164 = p_phone and phone_verified_at is not null and id <> p_user_id
    returning id
  loop
    update public.user_verifications
       set status = 'revoked'
     where user_id = v_other and verification_type = 'phone' and status = 'verified';
    insert into public.audit_events (actor_user_id, event_type, entity_type, entity_id, outcome, metadata)
    values (null, 'verification.phone_superseded', 'profile', v_other, 'success', '{}'::jsonb);
  end loop;

  update public.profiles
     set phone_e164 = p_phone,
         phone_verified_at = p_verified_at,
         pending_phone_e164 = null,
         phone_otp_sent_at = null
   where id = p_user_id;

  select id, status into v_id, v_status
    from public.user_verifications
   where user_id = p_user_id and verification_type = 'phone'
     for update;

  if not found then
    insert into public.user_verifications (user_id, verification_type, status, provider_name)
    values (p_user_id, 'phone', 'pending', 'supabase_auth')
    returning id, status into v_id, v_status;
  end if;

  if v_status in ('rejected', 'expired', 'revoked') then
    update public.user_verifications set status = 'pending' where id = v_id;
    v_status := 'pending';
  end if;

  update public.user_verifications
     set status = 'verified', verified_at = p_verified_at, provider_name = 'supabase_auth'
   where id = v_id;

  -- verified -> verified is not a status change, so the generic audit trigger
  -- stays silent; record the number change explicitly.
  if v_status = 'verified' and v_previous is distinct from p_phone then
    insert into public.audit_events (actor_user_id, event_type, entity_type, entity_id, outcome, metadata)
    values (p_user_id, 'verification.phone_changed', 'user_verification', v_id, 'success', '{}'::jsonb);
  end if;
end;
$$;

-- Audits a rejected confirmation attempt. Never changes the status.
create function public.phone_verification_failed(p_user_id uuid, p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_reason not in ('invalid_or_expired_code', 'account_mismatch', 'auth_state_mismatch') then
    raise exception 'unknown reason' using errcode = 'check_violation';
  end if;
  select id into v_id from public.user_verifications
   where user_id = p_user_id and verification_type = 'phone';
  insert into public.audit_events (actor_user_id, event_type, entity_type, entity_id, outcome, metadata)
  values (
    p_user_id,
    'verification.phone_code_rejected',
    case when v_id is null then null else 'user_verification' end,
    v_id,
    'failure',
    pg_catalog.jsonb_build_object('reason', p_reason)
  );
end;
$$;

-- Withdraws a verified number that Supabase Auth no longer reports as this
-- user's confirmed phone.
create function public.phone_verification_revoke(p_user_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.profiles set phone_verified_at = null
   where id = p_user_id and phone_verified_at is not null;
  update public.user_verifications set status = 'revoked'
   where user_id = p_user_id and verification_type = 'phone' and status = 'verified';
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

-- Supabase's default privileges make new functions executable by every API
-- role. Only the server may call these.
revoke execute on function
  public.phone_verification_begin(uuid, integer),
  public.phone_verification_release(uuid),
  public.phone_verification_pending(uuid, text, boolean),
  public.phone_verification_complete(uuid, text, timestamptz),
  public.phone_verification_failed(uuid, text),
  public.phone_verification_revoke(uuid)
  from public, anon, authenticated;

grant execute on function
  public.phone_verification_begin(uuid, integer),
  public.phone_verification_release(uuid),
  public.phone_verification_pending(uuid, text, boolean),
  public.phone_verification_complete(uuid, text, timestamptz),
  public.phone_verification_failed(uuid, text),
  public.phone_verification_revoke(uuid)
  to service_role;

-- New columns inherit nothing: authenticated users hold an UPDATE grant on
-- named profile columns only, so these stay server-written. SELECT on
-- profiles is table-wide, so users can read their own pending number.
