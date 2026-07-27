-- One-time email verification codes for password signup (5-minute OTP).
-- Service-role only — no client RLS policies.

create table if not exists public.email_verification_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  purpose text not null default 'signup',
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists email_verification_codes_email_purpose_idx
  on public.email_verification_codes (email, purpose, created_at desc);

create index if not exists email_verification_codes_expires_idx
  on public.email_verification_codes (expires_at);

alter table public.email_verification_codes enable row level security;

-- No policies for anon/authenticated — only service role (bypasses RLS) reads/writes.
