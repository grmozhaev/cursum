-- Proposed v2 storage migration. Do not apply until explicitly requested.
-- This table is independent of public.cursum_data, which stores v1 data.
create table public.cursum_v2_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.cursum_v2_data enable row level security;
revoke all on public.cursum_v2_data from anon, authenticated;
grant select on public.cursum_v2_data to authenticated;
create policy "Users read their own v2 data" on public.cursum_v2_data
  for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.save_cursum_v2_data(p_data jsonb, p_expected_revision bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare new_revision bigint;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'Invalid data'; end if;
  if p_expected_revision = 0 then
    insert into public.cursum_v2_data (user_id, data) values (auth.uid(), p_data)
      on conflict (user_id) do nothing returning revision into new_revision;
  else
    update public.cursum_v2_data set data = p_data, revision = revision + 1, updated_at = now()
      where user_id = auth.uid() and revision = p_expected_revision returning revision into new_revision;
  end if;
  return new_revision;
end $$;
revoke all on function public.save_cursum_v2_data(jsonb, bigint) from public, anon;
grant execute on function public.save_cursum_v2_data(jsonb, bigint) to authenticated;
