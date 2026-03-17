-- User feedback / bug reports / suggestions
create table if not exists user_feedback (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  type text not null check (type in ('bug', 'suggestion')),
  subject text,
  body text not null,
  created_at timestamptz default now()
);

alter table user_feedback enable row level security;

-- Users can insert their own feedback
create policy "Users can insert own feedback"
  on user_feedback for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Users can read their own feedback
create policy "Users can read own feedback"
  on user_feedback for select
  to authenticated
  using (auth.uid() = user_id);
