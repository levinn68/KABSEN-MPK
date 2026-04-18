-- Ganti DELETE_MEETING_PASSWORD dengan password yang kamu mau.

do $$
declare
  v_secret_id uuid;
begin
  select id
  into v_secret_id
  from vault.decrypted_secrets
  where name = 'delete_meeting_password'
  limit 1;

  if v_secret_id is null then
    perform vault.create_secret(
      'DELETE_MEETING_PASSWORD',
      'delete_meeting_password',
      'Password hapus meeting'
    );
  else
    perform vault.update_secret(
      v_secret_id,
      'DELETE_MEETING_PASSWORD',
      'delete_meeting_password',
      'Password hapus meeting'
    );
  end if;
end;
$$;

drop function if exists public.delete_meeting_session(bigint);
drop function if exists public.delete_meeting_session(bigint, text);

create or replace function public.delete_meeting_session(
  p_meeting_id bigint,
  p_password text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_password text;
begin
  select ds.decrypted_secret
  into v_password
  from vault.decrypted_secrets ds
  where ds.name = 'delete_meeting_password'
  limit 1;

  if v_password is null then
    raise exception 'Password delete belum diset';
  end if;

  if coalesce(trim(p_password), '') <> coalesce(v_password, '__never_match__') then
    raise exception 'Password salah';
  end if;

  delete from public.attendance
  where meeting_id = p_meeting_id;

  delete from public.meetings
  where id = p_meeting_id;
end;
$$;

revoke execute on function public.delete_meeting_session(bigint, text) from public, anon;
grant execute on function public.delete_meeting_session(bigint, text) to authenticated;
