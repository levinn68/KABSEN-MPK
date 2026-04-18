-- Ganti ADMIN_EXPORT_PASSWORD dengan password admin kamu.

do $$
declare
  v_secret_id uuid;
begin
  select id into v_secret_id
  from vault.decrypted_secrets
  where name = 'admin_export_password'
  limit 1;

  if v_secret_id is null then
    perform vault.create_secret(
      'ADMIN_EXPORT_PASSWORD',
      'admin_export_password',
      'Password akses admin export'
    );
  else
    perform vault.update_secret(
      v_secret_id,
      'ADMIN_EXPORT_PASSWORD',
      'admin_export_password',
      'Password akses admin export'
    );
  end if;
end;
$$;

create or replace function public.verify_admin_export_password(p_password text)
returns boolean
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
  where ds.name = 'admin_export_password'
  limit 1;

  return coalesce(p_password, '') = coalesce(v_password, '__never_match__');
end;
$$;

create or replace function public.admin_export_member_range_summary(
  p_password text,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_start_date is null or p_end_date is null then
    raise exception 'Tanggal mulai dan tanggal akhir wajib diisi';
  end if;

  if p_end_date < p_start_date then
    raise exception 'Tanggal akhir tidak boleh lebih kecil dari tanggal mulai';
  end if;

  if not public.verify_admin_export_password(p_password) then
    raise exception 'Password admin salah';
  end if;

  with members_base as (
    select m.id as member_id, m.full_name
    from public.members m
    where coalesce(m.is_active, true) = true
  ),
  meetings_in_range as (
    select mt.id as meeting_id
    from public.meetings mt
    where mt.meeting_date between p_start_date and p_end_date
  ),
  meeting_totals as (
    select count(*)::int as total_rapat from meetings_in_range
  ),
  attendance_unique as (
    select distinct a.member_id, a.meeting_id
    from public.attendance a
    join meetings_in_range mm on mm.meeting_id = a.meeting_id
    where coalesce(a.matched, false) = true
  ),
  meeting_member_counts as (
    select mb.member_id,
           mt.total_rapat,
           coalesce(count(au.meeting_id), 0)::int as ikut_rapat
    from members_base mb
    cross join meeting_totals mt
    left join attendance_unique au on au.member_id = mb.member_id
    group by mb.member_id, mt.total_rapat
  ),
  ro_assignments as (
    select distinct rs.member_id, rs.session_id
    from public.v_ro_picket_schedule rs
    where rs.duty_date between p_start_date and p_end_date
  ),
  ro_done as (
    select distinct rr.member_id, rr.session_id
    from public.v_ro_picket_recent_scans rr
    where coalesce(rr.duty_date, rr.scanned_at::date) between p_start_date and p_end_date
  ),
  ro_member_counts as (
    select mb.member_id,
           coalesce(count(ra.session_id), 0)::int as total_piket,
           coalesce(count(rd.session_id), 0)::int as piket
    from members_base mb
    left join ro_assignments ra on ra.member_id = mb.member_id
    left join ro_done rd on rd.member_id = ra.member_id and rd.session_id = ra.session_id
    group by mb.member_id
  ),
  cash_member_counts as (
    select mb.member_id,
           coalesce(sum(case when coalesce(cs.is_paid, false) then 1 else 0 end), 0)::int as bayar_kas,
           coalesce(sum(case when not coalesce(cs.is_paid, false) then 1 else 0 end), 0)::int as tunggakan,
           coalesce(sum(case when coalesce(cs.current_fine_amount, 0) > 0 then 1 else 0 end), 0)::int as kena_denda,
           coalesce(sum(coalesce(cs.base_amount, 0)), 0)::bigint as total_kas_pokok,
           coalesce(sum(coalesce(cs.current_fine_amount, 0)), 0)::bigint as total_denda,
           coalesce(sum(coalesce(cs.base_amount, 0) + coalesce(cs.current_fine_amount, 0)), 0)::bigint as total_keseluruhan
    from members_base mb
    left join public.v_cash_member_weekly_status cs
      on cs.member_id = mb.member_id
     and cs.cycle_start between p_start_date and p_end_date
    group by mb.member_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'member_id', mb.member_id,
        'full_name', mb.full_name,
        'rapat', jsonb_build_object(
          'total_rapat', coalesce(mc.total_rapat, 0),
          'ikut_rapat', coalesce(mc.ikut_rapat, 0),
          'tidak_rapat', greatest(coalesce(mc.total_rapat, 0) - coalesce(mc.ikut_rapat, 0), 0)
        ),
        'piket_rom', jsonb_build_object(
          'total_piket', coalesce(rc.total_piket, 0),
          'piket', coalesce(rc.piket, 0),
          'tidak_piket', greatest(coalesce(rc.total_piket, 0) - coalesce(rc.piket, 0), 0)
        ),
        'kas', jsonb_build_object(
          'bayar_kas', coalesce(cc.bayar_kas, 0),
          'tunggakan', coalesce(cc.tunggakan, 0),
          'kena_denda', coalesce(cc.kena_denda, 0),
          'total_kas_pokok', coalesce(cc.total_kas_pokok, 0),
          'total_denda', coalesce(cc.total_denda, 0),
          'total_keseluruhan', coalesce(cc.total_keseluruhan, 0)
        )
      )
      order by mb.full_name
    ),
    '[]'::jsonb
  )
  into v_result
  from members_base mb
  left join meeting_member_counts mc on mc.member_id = mb.member_id
  left join ro_member_counts rc on rc.member_id = mb.member_id
  left join cash_member_counts cc on cc.member_id = mb.member_id;

  return v_result;
end;
$$;

revoke execute on function public.verify_admin_export_password(text) from public;
revoke execute on function public.admin_export_member_range_summary(text, date, date) from public;

grant execute on function public.verify_admin_export_password(text) to anon, authenticated;
grant execute on function public.admin_export_member_range_summary(text, date, date) to anon, authenticated;
