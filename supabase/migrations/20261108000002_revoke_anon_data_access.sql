-- Supabase's inherited defaults may grant anon table privileges. Remove them
-- explicitly; authenticated access remains governed by the RLS policies.
revoke all on public.profiles, public.workspaces, public.workspace_members,
  public.projects, public.issues, public.issue_comments, public.issue_activity,
  public.workspace_invites from public, anon;

grant select on public.profiles, public.workspaces, public.workspace_members,
  public.projects, public.issues, public.issue_comments, public.issue_activity to authenticated;
