-- Quini6: estado privado por usuario y adjuntos privados.
-- Ejecutar una sola vez en Supabase > SQL Editor. Es seguro volver a ejecutarlo.

begin;

create table if not exists public.user_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{"draws": {}, "payments": {}}'::jsonb,
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  constraint user_states_state_is_object check (jsonb_typeof(state) = 'object'),
  constraint user_states_state_size check (octet_length(state::text) <= 1048576),
  constraint user_states_revision_positive check (revision >= 1)
);

comment on table public.user_states is
  'Un estado privado por usuario autenticado; las imágenes se guardan en Storage.';

alter table public.user_states enable row level security;
alter table public.user_states force row level security;

revoke all on table public.user_states from anon, authenticated;
grant select, insert, update on table public.user_states to authenticated;

drop policy if exists "user_states_select_own" on public.user_states;
create policy "user_states_select_own"
on public.user_states
for select
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "user_states_insert_own" on public.user_states;
create policy "user_states_insert_own"
on public.user_states
for insert
to authenticated
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "user_states_update_own" on public.user_states;
create policy "user_states_update_own"
on public.user_states
for update
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

create or replace function public.touch_user_state_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.touch_user_state_updated_at() from public, anon, authenticated;

drop trigger if exists user_states_touch_updated_at on public.user_states;
create trigger user_states_touch_updated_at
before update on public.user_states
for each row execute function public.touch_user_state_updated_at();

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'user-attachments',
  'user-attachments',
  false,
  5242880,
  array['image/jpeg']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "attachments_select_own" on storage.objects;
create policy "attachments_select_own"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'user-attachments'
  and (select auth.uid()) is not null
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "attachments_insert_own" on storage.objects;
create policy "attachments_insert_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'user-attachments'
  and (select auth.uid()) is not null
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "attachments_delete_own" on storage.objects;
create policy "attachments_delete_own"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'user-attachments'
  and (select auth.uid()) is not null
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

commit;
