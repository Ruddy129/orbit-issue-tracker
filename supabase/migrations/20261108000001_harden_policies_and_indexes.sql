-- Keep RLS helper functions outside the exposed public Data API schema.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.is_workspace_member(target_workspace_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = (select auth.uid())
  );
$$;

create or replace function private.is_workspace_admin(target_workspace_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = (select auth.uid())
      and wm.role in ('owner', 'admin')
  );
$$;

create or replace function private.shares_workspace_with(target_user_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members mine
    join public.workspace_members theirs using (workspace_id)
    where mine.user_id = (select auth.uid())
      and theirs.user_id = target_user_id
  );
$$;

revoke all on function private.is_workspace_member(uuid) from public, anon;
revoke all on function private.is_workspace_admin(uuid) from public, anon;
revoke all on function private.shares_workspace_with(uuid) from public, anon;
grant execute on function private.is_workspace_member(uuid) to authenticated;
grant execute on function private.is_workspace_admin(uuid) to authenticated;
grant execute on function private.shares_workspace_with(uuid) to authenticated;

drop policy "profiles are visible to self and teammates" on public.profiles;
create policy "profiles are visible to self and teammates"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.shares_workspace_with(id));

drop policy "workspace members can view their workspaces" on public.workspaces;
create policy "workspace members can view their workspaces"
  on public.workspaces for select to authenticated
  using (created_by = (select auth.uid()) or private.is_workspace_member(id));
drop policy "workspace admins can update workspaces" on public.workspaces;
create policy "workspace admins can update workspaces"
  on public.workspaces for update to authenticated
  using (private.is_workspace_admin(id)) with check (private.is_workspace_admin(id));
drop policy "workspace admins can delete workspaces" on public.workspaces;
create policy "workspace admins can delete workspaces"
  on public.workspaces for delete to authenticated
  using (private.is_workspace_admin(id));

drop policy "workspace members can view memberships" on public.workspace_members;
create policy "workspace members can view memberships"
  on public.workspace_members for select to authenticated
  using (private.is_workspace_member(workspace_id));
drop policy "workspace creators can add themselves as owner" on public.workspace_members;
drop policy "workspace admins can add members" on public.workspace_members;
create policy "workspace creators and admins can add members"
  on public.workspace_members for insert to authenticated
  with check (
    (user_id = (select auth.uid()) and role = 'owner'
      and exists (select 1 from public.workspaces w where w.id = workspace_id and w.created_by = (select auth.uid())))
    or (private.is_workspace_admin(workspace_id) and role = 'member')
  );
drop policy "workspace admins can remove non-owners" on public.workspace_members;
create policy "workspace admins can remove non-owners"
  on public.workspace_members for delete to authenticated
  using (private.is_workspace_admin(workspace_id) and role <> 'owner');

drop policy "workspace members can view projects" on public.projects;
create policy "workspace members can view projects"
  on public.projects for select to authenticated
  using (private.is_workspace_member(workspace_id));
drop policy "workspace admins can create projects" on public.projects;
create policy "workspace admins can create projects"
  on public.projects for insert to authenticated
  with check (private.is_workspace_admin(workspace_id) and created_by = (select auth.uid()));
drop policy "workspace admins can update projects" on public.projects;
create policy "workspace admins can update projects"
  on public.projects for update to authenticated
  using (private.is_workspace_admin(workspace_id)) with check (private.is_workspace_admin(workspace_id));
drop policy "workspace admins can delete projects" on public.projects;
create policy "workspace admins can delete projects"
  on public.projects for delete to authenticated
  using (private.is_workspace_admin(workspace_id));

drop policy "workspace members can view issues" on public.issues;
create policy "workspace members can view issues"
  on public.issues for select to authenticated
  using (private.is_workspace_member(workspace_id));
drop policy "workspace members can create issues" on public.issues;
create policy "workspace members can create issues"
  on public.issues for insert to authenticated
  with check (private.is_workspace_member(workspace_id) and created_by = (select auth.uid()));
drop policy "workspace members can update issues" on public.issues;
create policy "workspace members can update issues"
  on public.issues for update to authenticated
  using (private.is_workspace_member(workspace_id)) with check (private.is_workspace_member(workspace_id));
drop policy "workspace members can delete issues" on public.issues;
create policy "workspace members can delete issues"
  on public.issues for delete to authenticated
  using (private.is_workspace_member(workspace_id));

drop policy "workspace members can view comments" on public.issue_comments;
create policy "workspace members can view comments"
  on public.issue_comments for select to authenticated
  using (private.is_workspace_member(workspace_id));
drop policy "workspace members can add their own comments" on public.issue_comments;
create policy "workspace members can add their own comments"
  on public.issue_comments for insert to authenticated
  with check (private.is_workspace_member(workspace_id) and author_id = (select auth.uid()));
drop policy "authors and workspace admins can delete comments" on public.issue_comments;
create policy "authors and workspace admins can delete comments"
  on public.issue_comments for delete to authenticated
  using (author_id = (select auth.uid()) or private.is_workspace_admin(workspace_id));

drop policy "workspace members can view activity" on public.issue_activity;
create policy "workspace members can view activity"
  on public.issue_activity for select to authenticated
  using (private.is_workspace_member(workspace_id));

drop policy if exists "direct invite access denied" on public.workspace_invites;
create policy "direct invite access denied"
  on public.workspace_invites for all to authenticated
  using (false) with check (false);

create or replace function public.create_workspace_invite(target_workspace_id uuid)
returns text language plpgsql security definer
set search_path = ''
as $$
declare
  invite_token text;
begin
  if not private.is_workspace_admin(target_workspace_id) then
    raise exception 'Only a workspace admin can create an invite';
  end if;
  invite_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.workspace_invites (token, workspace_id, created_by, expires_at)
  values (invite_token, target_workspace_id, (select auth.uid()), now() + interval '7 days');
  return invite_token;
end;
$$;

create or replace function public.accept_workspace_invite(invite_token text)
returns uuid language plpgsql security definer
set search_path = ''
as $$
declare
  invite_row public.workspace_invites%rowtype;
  inserted_rows integer;
begin
  if (select auth.uid()) is null then
    raise exception 'Sign in before accepting a workspace invite';
  end if;
  select * into invite_row
  from public.workspace_invites wi
  where wi.token = invite_token and wi.expires_at > now() and wi.use_count < wi.max_uses
  for update;
  if not found then
    raise exception 'This workspace invite is invalid, expired, or full';
  end if;
  insert into public.workspace_members (workspace_id, user_id, role)
  values (invite_row.workspace_id, (select auth.uid()), 'member')
  on conflict (workspace_id, user_id) do nothing;
  get diagnostics inserted_rows = row_count;
  if inserted_rows > 0 then
    update public.workspace_invites set use_count = use_count + 1 where token = invite_row.token;
  end if;
  return invite_row.workspace_id;
end;
$$;

revoke all on function public.is_workspace_member(uuid) from public, anon, authenticated;
revoke all on function public.is_workspace_admin(uuid) from public, anon, authenticated;
revoke all on function public.shares_workspace_with(uuid) from public, anon, authenticated;
drop function public.is_workspace_member(uuid);
drop function public.is_workspace_admin(uuid);
drop function public.shares_workspace_with(uuid);
revoke all on function public.create_workspace_invite(uuid) from public, anon;
revoke all on function public.accept_workspace_invite(text) from public, anon;
grant execute on function public.create_workspace_invite(uuid) to authenticated;
grant execute on function public.accept_workspace_invite(text) to authenticated;

create index if not exists workspaces_created_by_idx on public.workspaces (created_by);
create index if not exists projects_created_by_idx on public.projects (created_by);
create index if not exists issues_project_workspace_fk_idx on public.issues (project_id, workspace_id);
create index if not exists issues_assignee_fk_idx on public.issues (assignee_id);
create index if not exists issues_created_by_idx on public.issues (created_by);
create index if not exists comments_issue_workspace_fk_idx on public.issue_comments (issue_id, workspace_id);
create index if not exists comments_workspace_idx on public.issue_comments (workspace_id);
create index if not exists comments_author_idx on public.issue_comments (author_id);
create index if not exists activity_issue_workspace_fk_idx on public.issue_activity (issue_id, workspace_id);
create index if not exists activity_workspace_idx on public.issue_activity (workspace_id);
create index if not exists activity_actor_idx on public.issue_activity (actor_id);
create index if not exists invites_workspace_idx on public.workspace_invites (workspace_id);
create index if not exists invites_created_by_idx on public.workspace_invites (created_by);
