-- Schema fingerprint: run on the live project (SQL editor) and locally (tests/live/schema-fingerprint.mjs);
-- identical rows mean the deployed functions/policies/grants/RLS/buckets match the repo migrations.
with items as (
  select 'fn' as kind,
         n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as k,
         md5(p.prosrc) || ':' || p.prosecdef || ':' || coalesce(array_to_string(p.proconfig, ','), '') || ':' ||
         has_function_privilege('anon', p.oid, 'execute') || ':' || has_function_privilege('authenticated', p.oid, 'execute') as v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private')
  union all
  select 'policy', schemaname || '.' || tablename || '.' || policyname,
         cmd || ':' || array_to_string(roles, ',') || ':' || permissive
    from pg_policies where schemaname in ('public', 'storage')
  union all
  select 'table', n.nspname || '.' || c.relname, c.relrowsecurity::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private') and c.relkind = 'r'
  union all
  select 'grant', table_schema || '.' || table_name || ':' || grantee, string_agg(privilege_type, ',' order by privilege_type)
    from information_schema.role_table_grants
   where table_schema in ('public', 'private') and grantee in ('anon', 'authenticated', 'PUBLIC')
   group by table_schema, table_name, grantee
  union all
  select 'bucket', id, public::text || ':' || coalesce(file_size_limit::text, '') || ':' || coalesce(array_to_string(allowed_mime_types, ','), '')
    from storage.buckets
)
select kind, count(*) as n, md5(string_agg(k || '=' || v, ';' order by k)) as digest from items group by kind order by kind;
