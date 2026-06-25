import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar.jsx';
import Aurora from '../components/Aurora.jsx';
import { analysis as analysisApi } from '../utils/api.js';
import { C, G, GLOBAL_CSS } from '../utils/design.js';

function StatusBadge({ status }) {
  const map = { completed:[C.teal,'✓ Complete'], running:[C.amber,'⟳ Running'], queued:[C.primary,'◷ Queued'], failed:[C.coral,'✕ Failed'] };
  const [color,label] = map[status] || [C.muted, status];
  return <span style={{ ...G.pill(color), fontSize: 10 }}>{label}</span>;
}

export default function Projects() {
  const nav = useNavigate();
  const [analyses, setAnalyses] = useState([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    analysisApi.list().then(r => setAnalyses(r.data.analyses || [])).finally(() => setLoading(false));
  }, []);

  const handleDelete = async (id) => {
    if (!confirm('Delete this analysis?')) return;
    await analysisApi.delete(id);
    setAnalyses(p => p.filter(a => a.id !== id));
  };

  const filtered = analyses.filter(a => {
    const matchSearch = !search || a.name.toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === 'all' || a.status === filter;
    return matchSearch && matchFilter;
  });

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'system-ui,-apple-system,sans-serif', color: C.text, display: 'flex' }}>
      <style>{GLOBAL_CSS}</style>
      <Aurora />
      <div style={{ width: 220, minHeight: '100vh', padding: '16px 10px', position: 'sticky', top: 0, height: '100vh', flexShrink: 0, zIndex: 10 }}>
        <Sidebar />
      </div>

      <div style={{ flex: 1, padding: '28px', position: 'relative', zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.5px' }}>📁 All Projects</h1>
          <button onClick={() => nav('/dashboard/new')} style={G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)', true)}>+ New Analysis</button>
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name..." style={{ ...G.input({ flex: 1, minWidth: 200 }) }} />
          <div style={{ display: 'flex', gap: 6 }}>
            {['all','completed','running','failed'].map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{ padding: '9px 16px', border: '1px solid', borderColor: filter === f ? C.primary : C.border, borderRadius: 10, background: filter === f ? 'rgba(139,124,248,0.15)' : 'transparent', color: filter === f ? '#C4B9FF' : C.muted, fontSize: 12, fontWeight: filter === f ? 600 : 400, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize' }}>{f}</button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div style={G.panel({ overflowX: 'auto' })}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px', color: C.muted }}>Loading...</div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{search || filter !== 'all' ? 'No matching analyses' : 'No analyses yet'}</div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 20 }}>Start your first analysis to see it here</div>
              <button onClick={() => nav('/dashboard/new')} style={G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)', true)}>New Analysis</button>
            </div>
          ) : (
            <table>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  {['Name','Status','File','Size','Created','Actions'].map(h=>(
                    <th key={h} style={{ padding: '10px 14px', fontSize: 10, color: C.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(a => (
                  <tr key={a.id} style={{ borderBottom: `1px solid ${C.border}`, transition: 'background 0.15s' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <td style={{ padding: '11px 14px', fontWeight: 600, fontSize: 13, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</td>
                    <td style={{ padding: '11px 14px' }}><StatusBadge status={a.status} /></td>
                    <td style={{ padding: '11px 14px', fontSize: 12, color: C.muted, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.original_name || '—'}</td>
                    <td style={{ padding: '11px 14px', fontSize: 12, color: C.muted }}>{a.file_size ? `${(a.file_size/1024/1024).toFixed(1)} MB` : '—'}</td>
                    <td style={{ padding: '11px 14px', fontSize: 12, color: C.muted }}>{new Date(a.created_at*1000).toLocaleDateString()}</td>
                    <td style={{ padding: '11px 14px' }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => nav(`/dashboard/analysis/${a.id}`)} style={G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)', true)}>View</button>
                        <button onClick={() => handleDelete(a.id)} style={{ ...G.btn('transparent', true), border: `1px solid rgba(255,83,112,0.3)`, color: C.coral }}>Del</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: C.dim }}>{filtered.length} of {analyses.length} analyses shown</div>
      </div>
    </div>
  );
}
