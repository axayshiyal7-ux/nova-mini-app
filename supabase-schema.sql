-- ================ NOVA Database Schema ================

-- USERS
create table if not exists users (
  telegram_id bigint primary key,
  username text,
  first_name text,
  balance numeric default 0,
  ads_watched_today int default 0,
  ads_watched_total int default 0,
  referral_count int default 0,
  referred_by bigint,
  wallet text,
  mining_started_at timestamptz,
  mining_collected_at timestamptz,
  created_at timestamptz default now()
);

-- ADS LOG
create table if not exists ads_log (
  id bigserial primary key,
  telegram_id bigint,
  reward numeric,
  created_at timestamptz default now()
);

-- TASKS
create table if not exists tasks (
  id bigserial primary key,
  title text not null,
  link text not null,
  chat_id text,
  type text default 'channel',
  reward numeric default 1,
  active boolean default true,
  created_at timestamptz default now()
);

-- TASK COMPLETIONS
create table if not exists task_completions (
  telegram_id bigint,
  task_id bigint,
  created_at timestamptz default now(),
  primary key (telegram_id, task_id)
);

-- WITHDRAWALS
create table if not exists withdrawals (
  id bigserial primary key,
  telegram_id bigint,
  amount numeric,
  wallet text,
  network text default 'polygon',
  status text default 'pending',
  created_at timestamptz default now()
);

-- REFERRALS
create table if not exists referrals (
  referrer_id bigint,
  referred_id bigint primary key,
  bonus_paid boolean default false,
  created_at timestamptz default now()
);

-- Indexes
create index if not exists idx_ads_user on ads_log(telegram_id);
create index if not exists idx_task_user on task_completions(telegram_id);
