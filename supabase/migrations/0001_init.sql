create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists bot_state (
  id int primary key default 1,
  equity numeric not null default 1000,
  target numeric not null default 1120,
  floor_amount numeric not null default 970,
  risk_per_trade numeric not null default 5,
  ntfy_topic text not null default 'change-moi-ce-topic-secret',
  active_trade jsonb,
  last_signal_types jsonb default '{}'::jsonb,
  last_exit_type text default 'hold',
  updated_at timestamptz default now(),
  constraint single_row check (id = 1)
);

insert into bot_state (id) values (1) on conflict (id) do nothing;
