# Orbit · Team issue tracker

Orbit is a collaborative issue tracker built with HTML, CSS, JavaScript, Supabase Auth, and PostgreSQL. It is a static web app: there is no application server to maintain.

## Run locally

From this folder, start a static server:

```powershell
python -m http.server 4173
```

Open `http://localhost:4173`. Use a local web server instead of opening `index.html` directly so Supabase Auth redirects work correctly.

## Create an account

1. Create an account with an email address and password.
2. Confirm the email if Supabase asks you to.
3. Create a workspace. Orbit adds three sample projects and a set of sample issues.
4. Use **Invite team** to copy an invite link. It expires after seven days and can be used by up to 25 teammates.

The app uses the public Supabase publishable key in `supabase-config.js`. This key is designed for browser use; never put a Supabase secret or service-role key in this project. Row Level Security limits access to workspace members.

## Supabase

The app is connected to the `orbit-issue-tracker` project in the `ap-south-1` region. Its schema and policies are in `supabase/migrations/`. The migrations create:

- User profiles, workspaces, workspace membership, and project records
- Issues with generated project keys, due dates, assignees, and status history
- Comments and seven-day workspace invite links
- Row Level Security policies, least-privilege Data API grants, and indexes

The migrations have already been applied to the connected Supabase project. For another Supabase project, apply all three SQL migrations in order and replace the URL and publishable key in `supabase-config.js`.

For production email confirmation, open the Supabase project and set **Authentication → URL Configuration → Site URL** to `https://orbit-issue-tracker.vercel.app`. Add `https://orbit-issue-tracker.vercel.app/**` and `http://localhost:4173/**` to the redirect URL allow list. Keep email confirmation enabled for normal sign-up.

## Features

- Kanban and list views with drag-and-drop status changes
- Create, edit, search, filter, assign, and delete issues
- Issue comments and an activity timeline for status, priority, and assignee changes
- Workspace creation and email/password authentication
- Team invites with expiring, limited-use links
- Live updates shared across signed-in teammates
- Responsive layout and browser session persistence

## Live demo

The production site is available at [https://orbit-issue-tracker.vercel.app](https://orbit-issue-tracker.vercel.app).

## Deploy

This is a static site. Deploy the project folder as-is to a static host such as Vercel. No build command or environment variables are required; the browser client configuration is in `supabase-config.js` and contains only the public URL and publishable key.
