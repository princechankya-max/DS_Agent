import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar.jsx';
import Aurora from '../components/Aurora.jsx';
import { analysis as analysisApi } from '../utils/api.js';
import { C, G, GLOBAL_CSS, PALETTE } from '../utils/design.js';
import { useAuth } from '../App.jsx';

function StatusBadge({ status }) {
  const map = { completed: [C.teal, '✓ Complete'], running: [C.amber, '⟳ Processing'], queued: [C.primary, '◷ Queued'], failed: [C.coral, '✕ Failed'] };
  const [color, label] = map[status] || [C.muted, status];
  return <span style={{ ...G.pill(color), fontSize: 10 }}>{label}</span>;
}

export default function Dashboard() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [analyses, setAnalyses] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    analysisApi.list().then(r => setAnalyses(r.data.analyses || [])).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const greeting = () => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  };

  const stats = [
    { label: 'Total Analyses', value: analyses.length, color: C.primary },
    { label: 'Completed', value: analyses.filter(a => a.status === 'completed').length, color: C.teal },
    { label: 'Processing', value: analyses.filter(a => a.status === 'running').length, color: C.amber },
    { label: 'This Month', value: analyses.filter(a => new Date(a.created_at*1000).getMonth() === new Date().getMonth()).length, color: C.rose },
  ];

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'system-ui,-apple-system,sans-serif', color: C.text, display: 'flex' }}>
      <style>{GLOBAL_CSS}</style>
      <Aurora />

      {/* Sidebar */}
      <div style={{ width: 220, minHeight: '100vh', padding: '16px 10px', position: 'sticky', top: 0, height: '100vh', flexShrink: 0, zIndex: 10 }}>
        <Sidebar />
      </div>

      {/* Main */}
      <div style={{ flex: 1, padding: '28px 28px 28px 16px', position: 'relative', zIndex: 1, overflowX: 'hidden' }}>
        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.5px', marginBottom: 4 }}>{greeting()}, {user?.name?.split(' ')[0]} ✦</h1>
          <p style={{ color: C.muted, fontSize: 13 }}>Here's your data science workspace</p>
        </div>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginBottom: 24 }}>
          {stats.map(s => (
            <div key={s.label} style={G.panel({ padding: '18px', background: `${s.color}10`, borderColor: `${s.color}22` })}>
              <div style={{ fontSize: 28, fontWeight: 900, color: s.color, letterSpacing: '-1px', marginBottom: 4 }}>{s.value}</div>
              <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* New Analysis CTA */}
        <div onClick={() => nav('/dashboard/new')} style={{ ...G.panel({ padding: '22px 28px', marginBottom: 20, cursor: 'pointer', background: 'linear-gradient(135deg,rgba(139,124,248,0.1),rgba(94,207,178,0.06))', borderColor: 'rgba(139,124,248,0.2)', transition: 'all 0.25s', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }) }}
          onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 12px 32px rgba(0,0,0,0.25)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>✦ Start New Analysis</div>
            <div style={{ fontSize: 13, color: C.muted }}>Upload CSV, Excel, JSON, or Parquet → get 5 deliverables</div>
          </div>
          <div style={{ fontSize: 24, opacity: 0.7 }}>→</div>
        </div>

        {/* Recent Analyses */}
        <div style={G.panel({ padding: '20px' })}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ fontSize: 13, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.6px' }}>📁 Recent Analyses</h3>
            <span onClick={() => nav('/dashboard/projects')} style={{ fontSize: 12, color: C.primary, cursor: 'pointer', fontWeight: 500 }}>View all →</span>
          </div>

          {loading ? (
            <div style={{ textAlign: 'center', padding: '30px', color: C.muted }}>Loading...</div>
          ) : analyses.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>No analyses yet</div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 20 }}>Upload your first dataset to get started</div>
              <button onClick={() => nav('/dashboard/new')} style={G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)', true)}>Start First Analysis</button>
            </div>
          ) : (
            <table>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  {['Name', 'Status', 'File Size', 'Created', 'Action'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', fontSize: 10, color: C.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {analyses.slice(0, 8).map(a => (
                  <tr key={a.id} style={{ borderBottom: `1px solid ${C.border}`, cursor: 'pointer', transition: 'background 0.15s' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <td style={{ padding: '11px 12px', fontWeight: 600, fontSize: 13, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</td>
                    <td style={{ padding: '11px 12px' }}><StatusBadge status={a.status} /></td>
                    <td style={{ padding: '11px 12px', fontSize: 12, color: C.muted }}>{a.file_size ? `${(a.file_size/1024/1024).toFixed(1)} MB` : '—'}</td>
                    <td style={{ padding: '11px 12px', fontSize: 12, color: C.muted }}>{new Date(a.created_at*1000).toLocaleDateString()}</td>
                    <td style={{ padding: '11px 12px' }}>
                      <button onClick={() => nav(`/dashboard/analysis/${a.id}`)} style={G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)', true)}>View →</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
