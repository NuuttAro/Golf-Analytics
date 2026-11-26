-- Carry — Supabase schema. Paste into Supabase → SQL Editor → Run (safe to re-run).
-- Row Level Security keeps every player's data private except rounds they
-- share with accepted friends.

-- ---------- profiles ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique not null check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null default '',
  units       text not null default 'yd' check (units in ('yd','m')),
  bag         text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "profiles readable by signed-in users" on public.profiles;
create policy "profiles readable by signed-in users" on public.profiles
  for select to authenticated using (true);
drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Create the profile row at sign-up from the username passed in user metadata.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name)
  values (new.id,
          lower(new.raw_user_meta_data->>'username'),
          coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'username'));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Username availability check usable before sign-up (no login yet).
create or replace function public.username_available(name text) returns boolean
language sql security definer set search_path = public stable as $$
  select not exists (select 1 from public.profiles where username = lower(name));
$$;
grant execute on function public.username_available(text) to anon, authenticated;

-- ---------- friendships ----------
create table if not exists public.friendships (
  requester  uuid not null references public.profiles(id) on delete cascade,
  addressee  uuid not null references public.profiles(id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending','accepted')),
  created_at timestamptz not null default now(),
  primary key (requester, addressee),
  check (requester <> addressee)
);
alter table public.friendships enable row level security;

drop policy if exists "see own friendships" on public.friendships;
create policy "see own friendships" on public.friendships
  for select to authenticated using (auth.uid() in (requester, addressee));
drop policy if exists "send requests" on public.friendships;
create policy "send requests" on public.friendships
  for insert to authenticated with check (requester = auth.uid() and status = 'pending');
-- No UPDATE policy: an update could rewrite `requester`. Accepting goes through
-- this function, which can only flip a request addressed to the caller.
drop policy if exists "accept requests sent to me" on public.friendships;
create or replace function public.accept_friend(from_user uuid) returns void
language sql security definer set search_path = public as $$
  update public.friendships set status = 'accepted'
  where requester = from_user and addressee = auth.uid() and status = 'pending';
$$;
revoke execute on function public.accept_friend(uuid) from public, anon;
grant execute on function public.accept_friend(uuid) to authenticated;
drop policy if exists "remove own friendships" on public.friendships;
create policy "remove own friendships" on public.friendships
  for delete to authenticated using (auth.uid() in (requester, addressee));

create or replace function public.are_friends(a uuid, b uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.friendships
                 where status = 'accepted'
                   and ((requester = a and addressee = b) or (requester = b and addressee = a)));
$$;
revoke execute on function public.are_friends(uuid, uuid) from public, anon;
grant execute on function public.are_friends(uuid, uuid) to authenticated;

-- ---------- rounds ----------
create table if not exists public.rounds (
  id          text primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  date        date not null,
  course      text not null,
  data        jsonb not null,           -- the full round: holes, shots, current hole
  summary     jsonb,                    -- score, toPar, putts, sg {...}; null while in progress
  visibility  text not null default 'friends' check (visibility in ('private','friends')),
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);
create index if not exists rounds_user_updated on public.rounds (user_id, updated_at);
alter table public.rounds enable row level security;

drop policy if exists "owner full access" on public.rounds;
create policy "owner full access" on public.rounds
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "friends read shared rounds" on public.rounds;
create policy "friends read shared rounds" on public.rounds
  for select to authenticated
  using (visibility = 'friends' and not deleted and public.are_friends(user_id, auth.uid()));

-- ---------- saved course layouts (per player) ----------
create table if not exists public.user_courses (
  user_id    uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  course_id  text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, course_id)
);
alter table public.user_courses enable row level security;
drop policy if exists "own courses" on public.user_courses;
create policy "own courses" on public.user_courses
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- keep updated_at current
create or replace function public.touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists rounds_touch on public.rounds;
create trigger rounds_touch before insert or update on public.rounds for each row execute function public.touch();
drop trigger if exists courses_touch on public.user_courses;
create trigger courses_touch before insert or update on public.user_courses for each row execute function public.touch();
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch();
