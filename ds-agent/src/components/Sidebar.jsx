import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../App.jsx';
import { C, G } from '../utils/design.js';

const NAV = [
  { path: '/dashboard',          icon: '📊', label: 'Dashboard'    },
  { path: '/dashboard/new',      icon: '✦',  label: 'New Analysis' },
  { path: '/dashboard/projects', icon: '📁', label: 'Projects'     },
];

export default function Sidebar() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const { user, logout } = useAuth();

  const handleLogout = async () => { await logout(); navigate('/'); };

  return (
    <div style={{ ...G.panel({ borderRadius: 16, padding: '20px 16px', display: 'flex', flexDirection: 'column', height: '100%' }) }}>
      {/* Logo */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 17, fontWeight: 900, background: 'linear-gradient(135deg,#8B7CF8,#5ECFB2)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', letterSpacing: '-0.3px' }}>✦ DS Agent</div>
        <div style={{ fontSize: 10, color: C.muted, marginTop: 3, letterSpacing: '0.3px' }}>Autonomous Data Science</div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1 }}>
        {NAV.map(item => {
          const active = location.pathname === item.path;
          return (
            <div key={item.path} onClick={() => navigate(item.path)} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 12px', borderRadius: 10, marginBottom: 4, cursor: 'pointer',
              background: active ? 'rgba(139,124,248,0.15)' : 'transparent',
              border: active ? '1px solid rgba(139,124,248,0.25)' : '1px solid transparent',
              color: active ? '#C4B9FF' : C.muted,
              fontSize: 13, fontWeight: active ? 600 : 500,
              transition: 'all 0.18s',
            }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ fontSize: 15 }}>{item.icon}</span>
              {item.label}
            </div>
          );
        })}
      </nav>

      {/* User + Logout */}
      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'linear-gradient(135deg,#8B7CF8,#5ECFB2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
            {user?.name?.[0]?.toUpperCase() || 'U'}
          </div>
          <div style={{ overflow: 'hidden' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name}</div>
            <div style={{ fontSize: 10, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.email}</div>
          </div>
        </div>
        <button onClick={handleLogout} style={{ width: '100%', background: 'transparent', border: `1px solid ${C.border}`, color: C.muted, borderRadius: 9, padding: '8px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.2s' }}
          onMouseEnter={e => { e.target.style.borderColor = C.coral; e.target.style.color = C.coral; }}
          onMouseLeave={e => { e.target.style.borderColor = C.border; e.target.style.color = C.muted; }}>
          Sign Out
        </button>
      </div>
    </div>
  );
}
