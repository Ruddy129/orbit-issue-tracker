const STATUSES = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'review', label: 'In review' },
  { id: 'done', label: 'Done' },
];
const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
const AVATAR_COLORS = ['#b18a56', '#d48f73', '#698ec2', '#a175bd', '#5ea38c', '#cf7683'];
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const icon = (name, extraClass = '') => `<svg class="icon ${extraClass}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const statusLabel = (id) => STATUSES.find((status) => status.id === id)?.label || 'Backlog';

let supabase = null;
let authMode = 'signin';
let state = {
  user: null,
  profile: null,
  workspace: null,
  workspaces: [],
  memberships: [],
  members: [],
  projects: [],
  issues: [],
  comments: [],
  activities: [],
};
let currentProject = 'all';
let currentNav = 'projects';
let currentView = 'board';
let selectedIssueId = null;
let draggedIssueId = null;
let workspaceChannel = null;
let refreshTimer = null;
let toastTimer = null;
let bootingUserId = null;

function setAuthAlert(message, kind = 'error') {
  const alert = $('#authAlert');
  alert.textContent = message;
  alert.className = `auth-alert ${kind === 'success' ? 'success' : ''}`;
  alert.classList.remove('hidden');
}

function clearAuthAlert() {
  $('#authAlert').textContent = '';
  $('#authAlert').className = 'auth-alert hidden';
}

function setWorkspaceAlert(message, kind = 'error') {
  const alert = $('#workspaceAlert');
  alert.textContent = message;
  alert.className = `auth-alert ${kind === 'success' ? 'success' : ''}`;
  alert.classList.remove('hidden');
}

function showToast(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function setBusy(button, busy, label = '') {
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.dataset.previousLabel = button.innerHTML;
    button.textContent = label || 'Please wait…';
  } else if (button.dataset.previousLabel) {
    button.innerHTML = button.dataset.previousLabel;
    delete button.dataset.previousLabel;
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const signingUp = mode === 'signup';
  $('#authKicker').textContent = signingUp ? 'GET YOUR TEAM MOVING' : 'WELCOME BACK';
  $('#authHeading').textContent = signingUp ? 'Create your account' : 'Sign in to Orbit';
  $('#authDescription').textContent = signingUp ? 'Start a workspace for the work you want to ship.' : 'Pick up where your team left off.';
  $('#authNameField').classList.toggle('hidden', !signingUp);
  $('#authName').required = signingUp;
  $('#authPassword').autocomplete = signingUp ? 'new-password' : 'current-password';
  $('#authSubmit').innerHTML = signingUp ? 'Create account <span>→</span>' : 'Sign in <span>→</span>';
  $('#authSwitchText').textContent = signingUp ? 'Already have an account?' : 'New to Orbit?';
  $('#authToggle').textContent = signingUp ? 'Sign in' : 'Create an account';
  clearAuthAlert();
}

function setAuthVisible(view = 'auth') {
  $('#appShell').classList.add('hidden');
  $('#authScreen').classList.remove('hidden');
  $('#authFormWrap').classList.toggle('hidden', view !== 'auth');
  $('#workspaceSetup').classList.toggle('hidden', view !== 'workspace');
  if (view === 'workspace') {
    $('#workspaceInput').value = state.profile?.display_name ? `${state.profile.display_name.split(' ')[0]}'s workspace` : '';
    $('#workspaceInput').focus();
  }
}

function initialsFor(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'TM';
  return (parts.length === 1 ? parts[0].slice(0, 2) : `${parts[0][0]}${parts[parts.length - 1][0]}`).toUpperCase();
}

function colorForUser(userId) {
  const index = Math.max(0, state.members.findIndex((member) => member.id === userId));
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}

function memberFor(userId) {
  if (!userId) return { id: null, display_name: 'Unassigned', initials: '—', color: '#bbbcc5' };
  const member = state.members.find((item) => item.id === userId);
  if (member) return { ...member, initials: initialsFor(member.display_name), color: colorForUser(userId) };
  if (state.user?.id === userId) {
    const name = state.profile?.display_name || state.user.email || 'You';
    return { id: userId, display_name: name, initials: initialsFor(name), color: AVATAR_COLORS[0] };
  }
  return { id: userId, display_name: 'Former member', initials: 'FM', color: '#a9aab5' };
}

function avatarMarkup(userId, extraClass = '') {
  const member = memberFor(userId);
  return `<span class="card-assignee ${extraClass}" style="background:${member.color}" title="${escapeHtml(member.display_name)}">${escapeHtml(member.initials)}</span>`;
}

function formatDate(dateString, options = { month: 'short', day: 'numeric' }) {
  if (!dateString) return 'No date';
  const date = new Date(`${dateString}T12:00:00`);
  return Number.isNaN(date.getTime()) ? 'No date' : new Intl.DateTimeFormat(undefined, options).format(date);
}

function relativeTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'just now';
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function projectFor(id) {
  return state.projects.find((project) => project.id === id) || { id, name: 'Project', key: 'ISS', color: '#7562dd', description: '' };
}

function scopedIssues() {
  let issues = state.issues;
  if (currentProject !== 'all') issues = issues.filter((issue) => issue.project_id === currentProject);
  if (currentNav === 'my-issues') issues = issues.filter((issue) => issue.assignee_id === state.user?.id);
  return issues;
}

function visibleIssues() {
  const query = $('#searchInput').value.trim().toLowerCase();
  const priority = $('#priorityFilter').value;
  return scopedIssues().filter((issue) => {
    const project = projectFor(issue.project_id);
    const person = memberFor(issue.assignee_id);
    const matchesQuery = !query || [issue.key, issue.title, issue.description, project.name, person.display_name].join(' ').toLowerCase().includes(query);
    return matchesQuery && (priority === 'all' || issue.priority === priority);
  });
}

function renderProjectNav() {
  const target = $('#projectNav');
  target.innerHTML = state.projects.map((project) => {
    const count = state.issues.filter((issue) => issue.project_id === project.id && issue.status !== 'done').length;
    return `<button class="project-link ${currentProject === project.id && currentNav === 'projects' ? 'selected' : ''}" data-project="${escapeHtml(project.id)}"><span class="project-symbol" style="background:${escapeHtml(project.color)}"></span><span>${escapeHtml(project.name)}</span><span class="project-issue-count">${count || ''}</span></button>`;
  }).join('');
  $$('.project-link', target).forEach((button) => button.addEventListener('click', () => {
    currentProject = button.dataset.project;
    currentNav = 'projects';
    render();
  }));
  const membership = state.memberships.find((item) => item.workspace_id === state.workspace?.id);
  $('#addProjectBtn').classList.toggle('hidden', !['owner', 'admin'].includes(membership?.role));
}

function renderWorkspaceMenu() {
  const menu = $('#workspaceMenu');
  menu.innerHTML = state.workspaces.map((workspace) => `<button type="button" class="${workspace.id === state.workspace?.id ? 'active' : ''}" data-workspace="${escapeHtml(workspace.id)}"><span></span>${escapeHtml(workspace.name)}</button>`).join('');
  menu.querySelectorAll('[data-workspace]').forEach((button) => button.addEventListener('click', async () => {
    const workspace = state.workspaces.find((item) => item.id === button.dataset.workspace);
    if (!workspace) return;
    state.workspace = workspace;
    currentProject = 'all';
    currentNav = 'overview';
    menu.classList.add('hidden');
    await loadWorkspaceData();
  }));
  if (state.workspaces.length < 2) $('#workspaceMenu').classList.add('hidden');
}

function renderIdentity() {
  const name = state.profile?.display_name || state.user?.email?.split('@')[0] || 'Team member';
  const initials = initialsFor(name);
  $('#profileName').textContent = name;
  $('#profileSubtitle').textContent = state.user?.email || 'Signed in';
  $('#profileAvatar').textContent = initials;
  $('#topAvatar').textContent = initials;
  $('#topAvatar').title = name;
  $('#workspaceName').textContent = state.workspace?.name || 'Workspace';
  $('#workspaceAvatar').textContent = initialsFor(state.workspace?.name || 'W').slice(0, 1);
  renderWorkspaceMenu();
}

function renderHeader() {
  const project = currentProject === 'all' ? null : projectFor(currentProject);
  const title = currentNav === 'my-issues' ? 'My issues' : currentProject === 'all' ? 'All issues' : project.name;
  const subtitle = currentNav === 'my-issues' ? 'Issues assigned to you across every project.' : currentProject === 'all' ? 'A view of everything your team is working on.' : project.description;
  $('#pageTitle').textContent = title;
  $('#pageSubtitle').textContent = subtitle || 'Plan the work, share progress, and ship together.';
  $('#breadcrumbProject').textContent = title;
  $('#projectEyebrow').textContent = currentProject === 'all' ? 'WORKSPACE OVERVIEW' : `${project.name.toUpperCase()} PROJECT`;
  $('.project-dot').style.background = project?.color || '#7562dd';
  $$('.primary-nav .nav-item[data-nav]').forEach((button) => button.classList.toggle('active', button.dataset.nav === currentNav));
}

function renderStats() {
  const issues = scopedIssues();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekEnd = new Date(today);
  weekEnd.setDate(weekEnd.getDate() + 7);
  $('#statOpen').textContent = issues.filter((issue) => issue.status !== 'done').length;
  $('#statProgress').textContent = issues.filter((issue) => issue.status === 'in-progress').length;
  $('#statDone').textContent = issues.filter((issue) => issue.status === 'done').length;
  $('#statDue').textContent = issues.filter((issue) => {
    if (!issue.due_date || issue.status === 'done') return false;
    const due = new Date(`${issue.due_date}T00:00:00`);
    return due >= today && due <= weekEnd;
  }).length;
  $('#issueTotal').textContent = `${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}`;
  $('#myIssueCount').textContent = state.issues.filter((issue) => issue.assignee_id === state.user?.id && issue.status !== 'done').length;
}

function cardMarkup(issue) {
  const project = projectFor(issue.project_id);
  const dueDate = issue.due_date ? new Date(`${issue.due_date}T23:59:59`) : null;
  const overdue = dueDate && dueDate < new Date() && issue.status !== 'done';
  const commentCount = state.comments.filter((comment) => comment.issue_id === issue.id).length;
  return `<article class="issue-card" draggable="true" data-issue="${escapeHtml(issue.id)}" tabindex="0" aria-label="Open ${escapeHtml(issue.key)} ${escapeHtml(issue.title)}">
    <div class="card-top"><span class="issue-key">${escapeHtml(issue.key)}</span><span class="priority priority-${escapeHtml(issue.priority)}">${escapeHtml(issue.priority)}</span></div>
    <h4 class="issue-title">${escapeHtml(issue.title)}</h4>
    ${issue.description ? `<p class="issue-description-preview">${escapeHtml(issue.description)}</p>` : ''}
    <div class="card-tags"><span class="card-tag">${escapeHtml(project.name)}</span></div>
    <div class="card-footer"><div class="card-meta">${dueDate ? `<span class="card-meta-item ${overdue ? 'overdue' : ''}" title="Due ${formatDate(issue.due_date, { month: 'long', day: 'numeric', year: 'numeric' })}">${icon('calendar')}${formatDate(issue.due_date)}</span>` : ''}${commentCount ? `<span class="card-meta-item" title="${commentCount} comments">${icon('message')}${commentCount}</span>` : ''}</div>${avatarMarkup(issue.assignee_id)}</div>
  </article>`;
}

function renderBoard(issues) {
  const board = $('#boardView');
  board.innerHTML = STATUSES.map((status) => {
    const rows = issues.filter((issue) => issue.status === status.id);
    return `<section class="board-column"><div class="column-heading" data-status="${status.id}"><span class="column-indicator"></span><h3>${status.label}</h3><span class="column-count">${rows.length}</span><button class="quiet-icon column-add" data-add-status="${status.id}" title="Add to ${status.label}" aria-label="Add issue to ${status.label}">${icon('plus')}</button></div><div class="column-body" data-drop-status="${status.id}">${rows.map(cardMarkup).join('')}<button class="add-card-button" data-add-status="${status.id}">${icon('plus')} Add an issue</button></div></section>`;
  }).join('');
  $$('.issue-card', board).forEach((card) => {
    card.addEventListener('click', () => openDetails(card.dataset.issue));
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetails(card.dataset.issue); } });
    card.addEventListener('dragstart', (event) => {
      draggedIssueId = card.dataset.issue;
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedIssueId);
    });
    card.addEventListener('dragend', () => { card.classList.remove('dragging'); $$('.column-body').forEach((column) => column.classList.remove('drag-over')); });
  });
  $$('.column-body', board).forEach((column) => {
    column.addEventListener('dragover', (event) => { event.preventDefault(); column.classList.add('drag-over'); });
    column.addEventListener('dragleave', (event) => { if (!column.contains(event.relatedTarget)) column.classList.remove('drag-over'); });
    column.addEventListener('drop', async (event) => {
      event.preventDefault();
      column.classList.remove('drag-over');
      const issueId = event.dataTransfer.getData('text/plain') || draggedIssueId;
      const issue = state.issues.find((item) => item.id === issueId);
      if (issue && issue.status !== column.dataset.dropStatus) await updateIssue(issue.id, { status: column.dataset.dropStatus });
    });
  });
  $$('[data-add-status]', board).forEach((button) => button.addEventListener('click', () => openIssueForm(null, button.dataset.addStatus)));
}

function renderList(issues) {
  const target = $('#listView');
  target.innerHTML = `<table class="issue-table"><thead><tr><th>ISSUE</th><th>STATUS</th><th>PRIORITY</th><th>PROJECT</th><th>ASSIGNEE</th><th>DUE DATE</th></tr></thead><tbody>${issues.map((issue) => {
    const project = projectFor(issue.project_id);
    const person = memberFor(issue.assignee_id);
    return `<tr data-issue="${escapeHtml(issue.id)}"><td><span class="issue-key">${escapeHtml(issue.key)}</span> <span class="table-title">${escapeHtml(issue.title)}</span></td><td><span class="status-pill status-${escapeHtml(issue.status)}">${statusLabel(issue.status)}</span></td><td><span class="priority priority-${escapeHtml(issue.priority)}">${escapeHtml(issue.priority)}</span></td><td>${escapeHtml(project.name)}</td><td><span class="table-person">${avatarMarkup(person.id)}${escapeHtml(person.display_name)}</span></td><td>${formatDate(issue.due_date)}</td></tr>`;
  }).join('')}</tbody></table>`;
  $$('tbody tr', target).forEach((row) => row.addEventListener('click', () => openDetails(row.dataset.issue)));
}

function render() {
  if (!state.workspace) return;
  renderIdentity();
  renderProjectNav();
  renderHeader();
  renderStats();
  const issues = visibleIssues();
  const hasIssues = issues.length > 0;
  $('#boardView').classList.toggle('hidden', currentView !== 'board' || !hasIssues);
  $('#listView').classList.toggle('hidden', currentView !== 'list' || !hasIssues);
  $('#emptyState').classList.toggle('hidden', hasIssues);
  if (currentView === 'board') renderBoard(issues);
  else renderList(issues);
  if (selectedIssueId && !$('#detailModal').classList.contains('hidden')) renderDetails();
}

function fillAssignees(select, selectedId = '') {
  const options = [{ id: '', display_name: 'Unassigned' }, ...state.members];
  select.innerHTML = options.map((member) => `<option value="${escapeHtml(member.id || '')}">${escapeHtml(member.display_name)}</option>`).join('');
  select.value = options.some((member) => member.id === selectedId) ? selectedId : '';
}

function fillProjectOptions(selectedId = currentProject === 'all' ? state.projects[0]?.id : currentProject) {
  const select = $('#issueProject');
  select.innerHTML = state.projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('');
  select.value = state.projects.some((project) => project.id === selectedId) ? selectedId : state.projects[0]?.id || '';
}

function showModal(modal) {
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function hideModal(modal) {
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  if ($('#issueModal').classList.contains('hidden') && $('#detailModal').classList.contains('hidden')) document.body.style.overflow = '';
}

function openIssueForm(issueId = null, defaultStatus = 'backlog') {
  const issue = issueId ? state.issues.find((item) => item.id === issueId) : null;
  $('#issueForm').reset();
  $('#issueId').value = issue?.id || '';
  $('#issueTitle').value = issue?.title || '';
  $('#issueDescription').value = issue?.description || '';
  fillProjectOptions(issue?.project_id);
  fillAssignees($('#issueAssignee'), issue?.assignee_id || state.user?.id || '');
  $('#issueStatus').value = issue?.status || defaultStatus;
  $('#issuePriority').value = issue?.priority || 'medium';
  $('#issueDueDate').value = issue?.due_date || '';
  $('#issueModalTitle').textContent = issue ? 'Edit issue' : 'Create an issue';
  $('#modalKicker').textContent = issue ? `EDIT ${issue.key}` : 'NEW ISSUE';
  $('#saveIssueBtn').textContent = issue ? 'Save changes' : 'Create issue';
  showModal($('#issueModal'));
  setTimeout(() => $('#issueTitle').focus(), 40);
}

function openDetails(issueId) {
  selectedIssueId = issueId;
  renderDetails();
  showModal($('#detailModal'));
}

function activityDescription(activity) {
  const oldValue = activity.old_value;
  const newValue = activity.new_value;
  if (activity.event_type === 'status_changed') return `moved this issue from ${statusLabel(oldValue)} to ${statusLabel(newValue)}`;
  if (activity.event_type === 'priority_changed') return `changed priority from ${String(oldValue || '').replaceAll('"', '')} to ${String(newValue || '').replaceAll('"', '')}`;
  if (activity.event_type === 'assignee_changed') {
    const oldAssignee = oldValue == null ? null : String(oldValue).replaceAll('"', '');
    const newAssignee = newValue == null ? null : String(newValue).replaceAll('"', '');
    return `changed the assignee from ${memberFor(oldAssignee).display_name} to ${memberFor(newAssignee).display_name}`;
  }
  return 'updated this issue';
}

function renderDetails() {
  const issue = state.issues.find((item) => item.id === selectedIssueId);
  if (!issue) return;
  const project = projectFor(issue.project_id);
  $('#detailProject').textContent = project.name;
  $('#detailKey').textContent = issue.key;
  $('#detailTitle').textContent = issue.title;
  $('#detailDescription').textContent = issue.description || 'No description provided.';
  $('#detailStatus').textContent = statusLabel(issue.status);
  $('#detailStatus').dataset.status = issue.status;
  const statusSelect = $('#detailStatusSelect');
  statusSelect.innerHTML = STATUSES.map((status) => `<option value="${status.id}">${status.label}</option>`).join('');
  statusSelect.value = issue.status;
  const prioritySelect = $('#detailPrioritySelect');
  prioritySelect.innerHTML = PRIORITIES.map((priority) => `<option value="${priority}">${priority[0].toUpperCase()}${priority.slice(1)}</option>`).join('');
  prioritySelect.value = issue.priority;
  fillAssignees($('#detailAssigneeSelect'), issue.assignee_id || '');
  $('#detailDueDate').textContent = issue.due_date ? formatDate(issue.due_date, { month: 'long', day: 'numeric', year: 'numeric' }) : 'No due date';

  const comments = state.comments.filter((comment) => comment.issue_id === issue.id).map((comment) => ({ kind: 'comment', ...comment }));
  const activities = state.activities.filter((activity) => activity.issue_id === issue.id).map((activity) => ({ kind: 'activity', ...activity }));
  const timeline = [...comments, ...activities].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  $('#commentCount').textContent = comments.length;
  $('#commentList').innerHTML = timeline.length ? timeline.map((item) => {
    const member = memberFor(item.kind === 'comment' ? item.author_id : item.actor_id);
    if (item.kind === 'comment') return `<article class="comment-item"><span class="member-avatar" style="background:${member.color}">${escapeHtml(member.initials)}</span><div><div class="comment-head"><span class="comment-author">${escapeHtml(member.display_name)}</span><span class="comment-time">${relativeTime(item.created_at)}</span></div><div class="comment-body">${escapeHtml(item.body)}</div></div></article>`;
    return `<article class="comment-item"><span class="member-avatar" style="background:${member.color}">${escapeHtml(member.initials)}</span><div><div class="comment-head"><span class="comment-author">${escapeHtml(member.display_name)}</span><span class="comment-time">${relativeTime(item.created_at)}</span></div><div class="comment-body">${escapeHtml(activityDescription(item))}</div></div></article>`;
  }).join('') : '<p class="comment-body no-comments">No activity yet. Start the conversation with a comment.</p>';
}

async function loadWorkspaceData() {
  if (!state.workspace || !supabase) return;
  const workspaceId = state.workspace.id;
  const [projectsResult, issuesResult, membershipsResult, commentsResult, activitiesResult] = await Promise.all([
    supabase.from('projects').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: true }),
    supabase.from('issues').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(500),
    supabase.from('workspace_members').select('workspace_id,user_id,role').eq('workspace_id', workspaceId).order('created_at', { ascending: true }),
    supabase.from('issue_comments').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: true }).limit(800),
    supabase.from('issue_activity').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: true }).limit(800),
  ]);
  const failed = [projectsResult, issuesResult, membershipsResult, commentsResult, activitiesResult].find((result) => result.error);
  if (failed) {
    showToast(failed.error.message || 'Could not load workspace data.', true);
    return;
  }
  const memberships = membershipsResult.data || [];
  const userIds = [...new Set(memberships.map((member) => member.user_id))];
  let profiles = [];
  if (userIds.length) {
    const { data, error } = await supabase.from('profiles').select('id,display_name').in('id', userIds);
    if (error) { showToast(error.message || 'Could not load workspace members.', true); return; }
    profiles = data || [];
  }
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  state.memberships = memberships;
  state.members = memberships.map((member) => ({
    id: member.user_id,
    role: member.role,
    display_name: profileById.get(member.user_id)?.display_name || (member.user_id === state.user?.id ? state.user.email : 'Team member'),
  }));
  state.projects = projectsResult.data || [];
  state.issues = issuesResult.data || [];
  state.comments = commentsResult.data || [];
  state.activities = activitiesResult.data || [];
  if (currentProject !== 'all' && !state.projects.some((project) => project.id === currentProject)) currentProject = 'all';
  render();
  subscribeToWorkspace(workspaceId);
}

function subscribeToWorkspace(workspaceId) {
  if (workspaceChannel) supabase.removeChannel(workspaceChannel);
  workspaceChannel = supabase.channel(`orbit-workspace-${workspaceId}`);
  ['workspace_members', 'projects', 'issues', 'issue_comments', 'issue_activity'].forEach((table) => {
    workspaceChannel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `workspace_id=eq.${workspaceId}` }, () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => loadWorkspaceData(), 180);
    });
  });
  workspaceChannel.subscribe((status) => {
    if (status === 'CHANNEL_ERROR') console.warn('Orbit could not subscribe to live workspace updates.');
  });
}

async function acceptInviteFromUrl() {
  const inviteToken = new URL(window.location.href).searchParams.get('invite');
  if (!inviteToken) return null;
  const { data, error } = await supabase.rpc('accept_workspace_invite', { invite_token: inviteToken });
  if (error) {
    showToast(error.message || 'Could not accept this invite.', true);
    return null;
  }
  const url = new URL(window.location.href);
  url.searchParams.delete('invite');
  window.history.replaceState({}, '', url);
  showToast('You joined the workspace.');
  return data;
}

async function bootstrapSession(session) {
  if (!session?.user) {
    bootingUserId = null;
    state.user = null;
    state.profile = null;
    state.workspace = null;
    state.workspaces = [];
    state.memberships = [];
    state.members = [];
    state.projects = [];
    state.issues = [];
    state.comments = [];
    state.activities = [];
    if (workspaceChannel) supabase.removeChannel(workspaceChannel);
    workspaceChannel = null;
    setAuthVisible('auth');
    return;
  }
  if (bootingUserId === session.user.id) return;
  if (state.user?.id === session.user.id && state.workspace) return;
  bootingUserId = session.user.id;
  state.user = session.user;
  $('#authScreen').classList.remove('hidden');
  $('#authFormWrap').classList.remove('hidden');
  $('#workspaceSetup').classList.add('hidden');
  clearAuthAlert();
  try {
    const [profileResult, invitedWorkspaceId] = await Promise.all([
      supabase.from('profiles').select('id,display_name').eq('id', session.user.id).maybeSingle(),
      acceptInviteFromUrl(),
    ]);
    if (profileResult.error) throw profileResult.error;
    state.profile = profileResult.data || { id: session.user.id, display_name: session.user.email?.split('@')[0] || 'Team member' };
    const { data: memberships, error: membershipError } = await supabase.from('workspace_members').select('workspace_id,role').eq('user_id', session.user.id);
    if (membershipError) throw membershipError;
    state.memberships = memberships || [];
    const workspaceIds = [...new Set(state.memberships.map((item) => item.workspace_id))];
    if (!workspaceIds.length) {
      state.workspaces = [];
      state.workspace = null;
      setAuthVisible('workspace');
      return;
    }
    const { data: workspaces, error: workspaceError } = await supabase.from('workspaces').select('id,name,created_by,created_at').in('id', workspaceIds).order('created_at', { ascending: true });
    if (workspaceError) throw workspaceError;
    state.workspaces = workspaces || [];
    state.workspace = state.workspaces.find((item) => item.id === invitedWorkspaceId)
      || state.workspaces.find((item) => item.id === state.workspace?.id)
      || state.workspaces[0]
      || null;
    if (!state.workspace) {
      setAuthVisible('workspace');
      return;
    }
    $('#authScreen').classList.add('hidden');
    $('#appShell').classList.remove('hidden');
    currentNav = currentProject === 'all' ? 'overview' : 'projects';
    await loadWorkspaceData();
  } catch (error) {
    console.error('Orbit could not load the signed-in workspace:', error);
    setAuthVisible('auth');
    setAuthAlert(error.message || 'Could not load your account. Please try again.');
  } finally {
    bootingUserId = null;
  }
}

async function createWorkspace(event) {
  event.preventDefault();
  const button = $('#workspaceForm button[type="submit"]');
  setBusy(button, true);
  $('#workspaceAlert').classList.add('hidden');
  try {
    const name = $('#workspaceInput').value.trim();
    const { data: workspace, error: workspaceError } = await supabase.from('workspaces')
      .insert({ name, created_by: state.user.id }).select('id,name,created_by,created_at').single();
    if (workspaceError) throw workspaceError;
    const { error: membershipError } = await supabase.from('workspace_members')
      .insert({ workspace_id: workspace.id, user_id: state.user.id, role: 'owner' });
    if (membershipError) throw membershipError;

    const starterProjects = [
      { name: 'Platform', key: 'ORB', color: '#7562dd', description: 'Build a reliable foundation for the next wave of product features.' },
      { name: 'Mobile app', key: 'MOB', color: '#e9a354', description: 'Create a fast, thoughtful mobile experience for every customer.' },
      { name: 'Website refresh', key: 'WEB', color: '#49b99a', description: 'Make our product story clear, useful, and easy to explore.' },
    ].map((project) => ({ ...project, workspace_id: workspace.id, created_by: state.user.id }));
    const { data: projects, error: projectError } = await supabase.from('projects').insert(starterProjects).select('id,name,key');
    if (projectError) throw projectError;
    const projectId = Object.fromEntries((projects || []).map((project) => [project.key, project.id]));
    const due = (days) => { const date = new Date(); date.setDate(date.getDate() + days); return date.toISOString().slice(0, 10); };
    const samples = [
      ['ORB', 'Fix token refresh race condition', 'Coordinate simultaneous refresh requests so the app only requests one new token.', 'in-progress', 'high', 3, true],
      ['ORB', 'Add audit log export', 'Allow workspace admins to export the audit log as a CSV file for compliance reviews.', 'backlog', 'medium', 6, true],
      ['ORB', 'Rate limit authentication endpoints', 'Add per-IP and per-account limits to sign-in and password reset endpoints.', 'review', 'urgent', 1, false],
      ['ORB', 'Standardize API error response schema', 'Use a shared error shape across services so clients can display actionable messages.', 'backlog', 'low', 9, false],
      ['ORB', 'Add workspace member roles', 'Support admin, member, and guest roles with clear project permissions.', 'in-progress', 'high', 4, true],
      ['ORB', 'Investigate slow dashboard queries', 'Capture query plans and identify the top bottleneck in the project overview.', 'in-progress', 'medium', -1, false],
      ['ORB', 'Add service health check endpoint', 'Expose a lightweight endpoint for deployment checks and uptime monitoring.', 'done', 'low', -4, true],
      ['ORB', 'Document pagination in the SDK', 'Add cursor pagination examples and explain how to resume a partial import.', 'done', 'medium', -6, false],
      ['ORB', 'Retry failed billing webhooks', 'Add exponential backoff and a way to replay failed deliveries.', 'backlog', 'high', 7, false],
      ['MOB', 'Design offline empty states', 'Give customers a clear path forward when they open the app without a network connection.', 'backlog', 'high', 8, true],
      ['MOB', 'Add onboarding flow coverage', 'Cover first-run setup and account recovery with end-to-end checks.', 'in-progress', 'medium', 2, false],
      ['WEB', 'Refresh the homepage hero layout', 'Explain the product in one sentence and make the primary action easy to find.', 'review', 'low', 5, true],
    ].map(([key, title, description, status, priority, days, assignToCreator]) => ({
      workspace_id: workspace.id,
      project_id: projectId[key],
      title,
      description,
      status,
      priority,
      due_date: due(days),
      assignee_id: assignToCreator ? state.user.id : null,
      created_by: state.user.id,
    }));
    const { data: createdIssues, error: issueError } = await supabase.from('issues').insert(samples).select('id,title');
    if (issueError) throw issueError;
    const seedIssue = createdIssues?.find((issue) => issue.title === 'Rate limit authentication endpoints');
    if (seedIssue) {
      const { error: commentError } = await supabase.from('issue_comments').insert({ workspace_id: workspace.id, issue_id: seedIssue.id, author_id: state.user.id, body: 'The implementation is ready for review. I added the rate-limit headers to the response too.' });
      if (commentError) console.warn('Could not add the starter comment:', commentError.message);
    }
    state.workspace = workspace;
    state.workspaces = [workspace];
    currentProject = projectId.ORB || 'all';
    currentNav = 'projects';
    $('#appShell').classList.remove('hidden');
    $('#authScreen').classList.add('hidden');
    await loadWorkspaceData();
    showToast('Workspace created. Your sample board is ready.');
  } catch (error) {
    console.error('Orbit could not create the workspace:', error);
    setWorkspaceAlert(error.message || 'Could not create your workspace. Please try again.');
  } finally {
    setBusy(button, false);
  }
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  clearAuthAlert();
  const button = $('#authSubmit');
  setBusy(button, true);
  try {
    const email = $('#authEmail').value.trim();
    const password = $('#authPassword').value;
    let result;
    if (authMode === 'signup') {
      const fullName = $('#authName').value.trim();
      result = await supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: fullName }, emailRedirectTo: window.location.href },
      });
      if (result.error) throw result.error;
      if (result.data.session) {
        await bootstrapSession(result.data.session);
      } else {
        setAuthAlert('Check your email for the confirmation link, then return here to create your workspace.', 'success');
      }
    } else {
      result = await supabase.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      await bootstrapSession(result.data.session);
    }
  } catch (error) {
    setAuthAlert(error.message || 'Could not sign in. Check your details and try again.');
  } finally {
    setBusy(button, false);
  }
}

async function updateIssue(issueId, changes) {
  const { error } = await supabase.from('issues').update(changes).eq('id', issueId);
  if (error) { showToast(error.message || 'Could not update this issue.', true); return; }
  await loadWorkspaceData();
  const issue = state.issues.find((item) => item.id === issueId);
  if (issue) showToast(`${issue.key} updated.`);
}

function updateSelectedIssue(field, value) {
  const issue = state.issues.find((item) => item.id === selectedIssueId);
  if (!issue) return;
  updateIssue(issue.id, { [field]: value }).catch((error) => showToast(error.message || 'Could not update this issue.', true));
}

async function handleIssueSubmit(event) {
  event.preventDefault();
  const button = $('#saveIssueBtn');
  setBusy(button, true);
  const id = $('#issueId').value;
  const existing = state.issues.find((issue) => issue.id === id);
  const payload = {
    project_id: $('#issueProject').value,
    title: $('#issueTitle').value.trim(),
    description: $('#issueDescription').value.trim(),
    status: $('#issueStatus').value,
    priority: $('#issuePriority').value,
    assignee_id: $('#issueAssignee').value || null,
    due_date: $('#issueDueDate').value || null,
  };
  try {
    let result;
    if (existing) {
      result = await supabase.from('issues').update(payload).eq('id', id).select('id,key').single();
    } else {
      result = await supabase.from('issues').insert({ ...payload, workspace_id: state.workspace.id, created_by: state.user.id }).select('id,key').single();
    }
    if (result.error) throw result.error;
    hideModal($('#issueModal'));
    await loadWorkspaceData();
    showToast(existing ? 'Issue updated.' : `Created ${result.data.key}.`);
  } catch (error) {
    showToast(error.message || 'Could not save this issue.', true);
  } finally {
    setBusy(button, false);
  }
}

async function addComment(event) {
  event.preventDefault();
  const body = $('#commentInput').value.trim();
  if (!body || !selectedIssueId) return;
  const button = $('#commentForm button[type="submit"]');
  setBusy(button, true);
  const { error } = await supabase.from('issue_comments').insert({
    workspace_id: state.workspace.id,
    issue_id: selectedIssueId,
    author_id: state.user.id,
    body,
  });
  if (error) showToast(error.message || 'Could not add your comment.', true);
  else {
    $('#commentInput').value = '';
    await loadWorkspaceData();
    showToast('Comment added.');
  }
  setBusy(button, false);
}

async function deleteIssue() {
  const issue = state.issues.find((item) => item.id === selectedIssueId);
  if (!issue || !window.confirm(`Delete ${issue.key} “${issue.title}”? This cannot be undone.`)) return;
  const { error } = await supabase.from('issues').delete().eq('id', issue.id);
  if (error) { showToast(error.message || 'Could not delete this issue.', true); return; }
  hideModal($('#detailModal'));
  selectedIssueId = null;
  await loadWorkspaceData();
  showToast(`${issue.key} deleted.`);
}

async function addProject() {
  const name = window.prompt('What is the new project called?');
  if (!name?.trim()) return;
  const baseKey = name.trim().split(/\s+/).map((part) => part[0]).join('').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'NEW';
  const enteredKey = window.prompt('Choose a 2–6 character project key.', baseKey.length > 1 ? baseKey : `${baseKey}1`);
  if (!enteredKey) return;
  const key = enteredKey.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,6}$/.test(key)) { showToast('Project keys must be 2–6 letters or numbers.', true); return; }
  const { data, error } = await supabase.from('projects').insert({
    workspace_id: state.workspace.id,
    name: name.trim().slice(0, 60),
    key,
    color: AVATAR_COLORS[state.projects.length % AVATAR_COLORS.length],
    description: '',
    created_by: state.user.id,
  }).select('id,name').single();
  if (error) { showToast(error.message || 'Could not add the project.', true); return; }
  await loadWorkspaceData();
  currentProject = data.id;
  currentNav = 'projects';
  render();
  showToast(`${data.name} project created.`);
}

async function inviteTeam() {
  const { data: token, error } = await supabase.rpc('create_workspace_invite', { target_workspace_id: state.workspace.id });
  if (error) { showToast(error.message || 'Could not create an invite link.', true); return; }
  const link = new URL(window.location.href);
  link.searchParams.set('invite', token);
  try {
    await navigator.clipboard.writeText(link.href);
    showToast('Seven-day invite link copied.');
  } catch {
    window.prompt('Copy this seven-day invite link:', link.href);
  }
}

function setNavigation(nav) {
  currentNav = nav;
  currentProject = nav === 'projects' ? state.projects[0]?.id || 'all' : 'all';
  render();
}

function initEvents() {
  $('#authForm').addEventListener('submit', handleAuthSubmit);
  $('#authToggle').addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));
  $('#workspaceForm').addEventListener('submit', createWorkspace);
  $$('.primary-nav .nav-item[data-nav]').forEach((button) => button.addEventListener('click', () => setNavigation(button.dataset.nav)));
  $('#newIssueBtn').addEventListener('click', () => openIssueForm());
  $('#emptyNewIssue').addEventListener('click', () => openIssueForm());
  $('#issueForm').addEventListener('submit', handleIssueSubmit);
  $('#searchInput').addEventListener('input', render);
  $('#priorityFilter').addEventListener('change', render);
  $$('.view-button').forEach((button) => button.addEventListener('click', () => {
    currentView = button.dataset.view;
    $$('.view-button').forEach((item) => item.classList.toggle('active', item === button));
    render();
  }));
  $$('.close-modal').forEach((button) => button.addEventListener('click', () => hideModal($('#issueModal'))));
  $$('.close-detail').forEach((button) => button.addEventListener('click', () => hideModal($('#detailModal'))));
  $('#issueModal').addEventListener('click', (event) => { if (event.target === $('#issueModal')) hideModal($('#issueModal')); });
  $('#detailModal').addEventListener('click', (event) => { if (event.target === $('#detailModal')) hideModal($('#detailModal')); });
  $('#editIssueBtn').addEventListener('click', () => {
    const issueId = selectedIssueId;
    hideModal($('#detailModal'));
    openIssueForm(issueId);
  });
  $('#deleteIssueBtn').addEventListener('click', deleteIssue);
  $('#detailStatusSelect').addEventListener('change', (event) => updateSelectedIssue('status', event.target.value));
  $('#detailPrioritySelect').addEventListener('change', (event) => updateSelectedIssue('priority', event.target.value));
  $('#detailAssigneeSelect').addEventListener('change', (event) => updateSelectedIssue('assignee_id', event.target.value || null));
  $('#commentForm').addEventListener('submit', addComment);
  $('#addProjectBtn').addEventListener('click', addProject);
  $('#shareBtn').addEventListener('click', inviteTeam);
  $('#signOutBtn').addEventListener('click', async () => {
    const { error } = await supabase.auth.signOut();
    if (error) showToast(error.message || 'Could not sign out.', true);
  });
  $('#workspaceSwitcher').addEventListener('click', () => {
    if (state.workspaces.length > 1) $('#workspaceMenu').classList.toggle('hidden');
    else showToast('Invite teammates to share this workspace.');
  });
  document.addEventListener('click', (event) => {
    if (!$('#workspaceSwitcher').contains(event.target) && !$('#workspaceMenu').contains(event.target)) $('#workspaceMenu').classList.add('hidden');
  });
  $('.help-link').addEventListener('click', () => showToast('Tip: drag an issue card to change its status.'));
  $('.notification-btn').addEventListener('click', () => showToast('You’re all caught up.'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('#issueModal').classList.contains('hidden')) hideModal($('#issueModal'));
      else if (!$('#detailModal').classList.contains('hidden')) hideModal($('#detailModal'));
      $('#workspaceMenu').classList.add('hidden');
    }
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && $('#issueModal').classList.contains('hidden') && $('#detailModal').classList.contains('hidden')) {
      event.preventDefault();
      $('#searchInput').focus();
    }
  });
}

async function init() {
  initEvents();
  setAuthMode('signin');
  const config = window.ORBIT_SUPABASE_CONFIG;
  if (!config?.url || !config?.publishableKey) {
    setAuthAlert('Supabase is not configured. Add the project URL and publishable key to supabase-config.js.');
    return;
  }
  if (!window.supabase?.createClient) {
    setAuthAlert('The Supabase client did not load. Check your connection and refresh.');
    return;
  }
  supabase = window.supabase.createClient(config.url, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    setAuthAlert(error.message || 'Could not check your sign-in session.');
    return;
  }
  await bootstrapSession(data.session);
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
      setTimeout(() => bootstrapSession(session), 0);
    }
  });
}

init();
