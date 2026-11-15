import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Sidebar from '../components/Sidebar.jsx';
import Aurora from '../components/Aurora.jsx';
import { workspaces as workspaceApi } from '../utils/api.js';
import { useAuth } from '../App.jsx';
import { C, G, GLOBAL_CSS } from '../utils/design.js';

function WorkspaceShell({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, display: 'flex', fontFamily: 'system-ui,-apple-system,sans-serif' }}>
      <style>{GLOBAL_CSS}</style>
      <Aurora />
      <aside style={{ width: 220, minHeight: '100vh', padding: '16px 10px', position: 'sticky', top: 0, height: '100vh', flexShrink: 0, zIndex: 10 }}>
        <Sidebar />
      </aside>
      <main style={{ flex: 1, padding: 28, position: 'relative', zIndex: 1, maxWidth: 1000, margin: '0 auto', width: '100%' }}>
        {children}
      </main>
    </div>
  );
}

export function WorkspaceSettings() {
  const { user } = useAuth();
  const [workspaces, setWorkspaces] = useState([]);
  const [members, setMembers] = useState([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const activeId = localStorage.getItem('ds_workspace_id') || user?.workspace?.id;
  const activeRole = workspaces.find(workspace => workspace.id === activeId)?.role;

  const load = useCallback(async () => {
    try {
      const { data } = await workspaceApi.list();
      setWorkspaces(data.workspaces);
      if (activeId) {
        const response = await workspaceApi.members(activeId);
        setMembers(response.data.members);
      }
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Could not load workspace details.');
    }
  }, [activeId]);

  useEffect(() => { load(); }, [load]);

  const createWorkspace = async event => {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      const { data } = await workspaceApi.create(name);
      localStorage.setItem('ds_workspace_id', data.workspace.id);
      window.location.reload();
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Could not create workspace.');
    } finally { setBusy(false); }
  };

  const invite = async event => {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      const { data } = await workspaceApi.invite(activeId, email, inviteRole);
      setMessage(data.message);
      setEmail('');
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Could not send invitation.');
    } finally { setBusy(false); }
  };

  const removeMember = async memberId => {
    setError('');
    setMessage('');
    try {
      const { data } = await workspaceApi.removeMember(activeId, memberId);
      setMessage(data.message);
      await load();
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Could not remove workspace member.');
    }
  };

  const selectWorkspace = workspaceId => {
    localStorage.setItem('ds_workspace_id', workspaceId);
    window.location.reload();
  };

  return (
    <WorkspaceShell>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Workspaces & members</h1>
      <p style={{ color: C.muted, marginBottom: 22 }}>Workspace data and analysis access are isolated by membership.</p>
      {error && <p role="alert" style={{ color: C.coral }}>{error}</p>}
      {message && <p role="status" style={{ color: C.teal }}>{message}</p>}

      <section style={G.panel({ padding: 20, marginBottom: 18 })}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Your workspaces</h2>
        {workspaces.map(workspace => (
          <button key={workspace.id} onClick={() => selectWorkspace(workspace.id)}
            style={{ ...G.btn(workspace.id === activeId ? 'rgba(139,124,248,0.2)' : 'rgba(255,255,255,0.04)'), marginRight: 8, marginBottom: 8, border: `1px solid ${workspace.id === activeId ? C.primary : C.border}` }}>
            {workspace.name} · {workspace.role}
          </button>
        ))}
        <form onSubmit={createWorkspace} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input value={name} onChange={event => setName(event.target.value)} required maxLength={100} placeholder="New workspace name" style={G.input()} />
          <button disabled={busy} style={G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)')}>Create</button>
        </form>
      </section>

      <section style={G.panel({ padding: 20, marginBottom: 18 })}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Invite a member</h2>
        <p style={{ color: C.muted, fontSize: 12 }}>Invited users must register and verify the same email address before accepting.</p>
        <form onSubmit={invite} style={{ display: 'flex', gap: 8 }}>
          <input type="email" value={email} onChange={event => setEmail(event.target.value)} required placeholder="teammate@example.com" style={G.input()} />
          <select value={inviteRole} onChange={event => setInviteRole(event.target.value)} aria-label="Invitation role"
            style={{ ...G.input(), width: 130 }}>
            <option value="member">Member</option><option value="admin">Admin</option>
          </select>
          <button disabled={busy || !activeId} style={G.btn('linear-gradient(135deg,#5ECFB2,#059669)')}>Send invitation</button>
        </form>
      </section>

      <section style={G.panel({ padding: 20 })}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Members</h2>
        {members.map(member => (
          <div key={member.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
            <span>{member.name} · {member.email}</span>
            <span style={{ color: C.muted, display: 'flex', alignItems: 'center', gap: 10 }}>
              {member.role}
              {member.id !== user?.id && ['owner', 'admin'].includes(activeRole) &&
                <button onClick={() => removeMember(member.id)} style={{ ...G.btn('rgba(255,83,112,0.12)'), color: C.coral, fontSize: 11 }}>Remove</button>}
            </span>
          </div>
        ))}
      </section>
    </WorkspaceShell>
  );
}

export function AcceptWorkspaceInvitation() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState(user ? 'Accepting invitation...' : 'Sign in with the invited email address to accept this invitation.');
  const [error, setError] = useState('');
  const token = params.get('token');

  useEffect(() => {
    if (!user || !token) return;
    workspaceApi.acceptInvite(token).then(({ data }) => {
      localStorage.setItem('ds_workspace_id', data.workspace_id);
      setStatus('Invitation accepted. Opening your workspace...');
      setTimeout(() => navigate('/dashboard/workspace'), 700);
    }).catch(requestError => {
      setError(requestError.response?.data?.error || 'Could not accept invitation.');
      setStatus('');
    });
  }, [navigate, token, user]);

  return (
    <WorkspaceShell>
      <h1 style={{ fontSize: 24 }}>Workspace invitation</h1>
      {!token && <p role="alert" style={{ color: C.coral }}>Invitation token is missing.</p>}
      {status && <p>{status}</p>}
      {error && <p role="alert" style={{ color: C.coral }}>{error}</p>}
      {!user && <Link to="/signin" style={{ color: C.primary }}>Sign in, then reopen the invitation link.</Link>}
    </WorkspaceShell>
  );
}
