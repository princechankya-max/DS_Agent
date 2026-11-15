import { useNavigate } from 'react-router-dom';
import Aurora from '../components/Aurora.jsx';
import { C, G, GLOBAL_CSS } from '../utils/design.js';
import { PLANS } from '../../shared/plans.js';

export default function Landing() {
  const nav = useNavigate();
  const features = [
    { icon: '📤', title: 'Smart Upload', desc: 'Upload CSV, Excel, JSON, and Parquet datasets up to 100MB.', color: C.primary },
    { icon: '🧹', title: 'Auto ETL', desc: 'Null handling, type fixing, outlier capping, deduplication. Full audit log.', color: C.teal },
    { icon: '📊', title: 'Rich EDA', desc: 'Statistical summaries, correlations, data-quality insights, and outlier handling.', color: C.amber },
    { icon: '🎨', title: 'Dataset Visualizations', desc: 'Distribution, category-count, correlation, missing-value, and pair plots.', color: C.rose },
    { icon: '🤖', title: 'ML Baselines', desc: 'Compare classification or regression baselines on a held-out test set.', color: C.primary },
    { icon: '📥', title: 'Analysis Reports', desc: 'Download cleaned data, EDA and insights reports, charts, and a notebook.', color: C.teal },
  ];
  const steps = [
    { icon: '📤', title: 'Upload', desc: 'Drag & drop your CSV, Excel, JSON, or Parquet file' },
    { icon: '🔍', title: 'Profile', desc: 'Auto-detect types, nulls, stats, and data quality issues' },
    { icon: '🧹', title: 'Clean', desc: 'ETL pipeline runs automatically with full before/after log' },
    { icon: '📊', title: 'Analyze', desc: 'EDA + visualizations + optional ML modeling' },
    { icon: '📥', title: 'Download', desc: 'Download the five core analysis deliverables' },
  ];

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'system-ui,-apple-system,sans-serif', color: C.text, position: 'relative' }}>
      <style>{GLOBAL_CSS}</style>
      <Aurora />

      {/* NAV */}
      <nav style={{ position: 'sticky', top: 0, zIndex: 100, background: 'rgba(5,6,15,0.75)', backdropFilter: 'blur(24px)', borderBottom: `1px solid ${C.border}`, padding: '0 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', height: 64, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 18, fontWeight: 900, background: 'linear-gradient(135deg,#8B7CF8,#5ECFB2)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', letterSpacing: '-0.5px' }}>✦ DS Agent</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => nav('/signin')} style={{ background: 'transparent', border: `1px solid ${C.border}`, color: C.muted, padding: '9px 20px', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.2s' }}>Sign In</button>
            <button onClick={() => nav('/signup')} style={{ ...G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)', true), boxShadow: '0 4px 20px rgba(139,124,248,0.25)' }}>Get Started Free</button>
          </div>
        </div>
      </nav>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 24px', position: 'relative', zIndex: 1 }}>
        {/* HERO */}
        <div style={{ padding: '100px 0 80px', textAlign: 'center', animation: 'fadeUp 0.7s ease' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'rgba(139,124,248,0.1)', border: '1px solid rgba(139,124,248,0.22)', borderRadius: 20, padding: '6px 16px', fontSize: 12, color: '#A89CF8', fontWeight: 600, letterSpacing: '0.3px', marginBottom: 28 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.primary, display: 'inline-block', animation: 'blink 2s ease-in-out infinite' }} />
            Autonomous AI Data Science — v1.0
          </div>
          <h1 style={{ fontSize: 'clamp(40px,5.5vw,68px)', fontWeight: 900, letterSpacing: '-2.5px', lineHeight: 1.04, marginBottom: 22 }}>
            Your Data.<br />
            <span style={{ background: 'linear-gradient(135deg,#8B7CF8 0%,#C4B9FF 45%,#5ECFB2 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Analyzed Instantly.</span>
          </h1>
          <p style={{ color: C.muted, fontSize: 18, maxWidth: 520, margin: '0 auto 36px', lineHeight: 1.7 }}>Upload a dataset for automated cleaning, EDA, visualizations, data insights, and optional ML baselines.</p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button onClick={() => nav('/signup')} style={{ ...G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)'), fontSize: 15, padding: '14px 36px', boxShadow: '0 6px 32px rgba(139,124,248,0.32)', borderRadius: 13 }}
              onMouseEnter={e => { e.target.style.transform = 'translateY(-3px)'; e.target.style.boxShadow = '0 12px 40px rgba(139,124,248,0.45)'; }}
              onMouseLeave={e => { e.target.style.transform = 'none'; e.target.style.boxShadow = '0 6px 32px rgba(139,124,248,0.32)'; }}>
              Start Analyzing Free →
            </button>
            <button onClick={() => nav('/signin')} style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${C.border}`, color: C.text, fontSize: 15, padding: '14px 32px', borderRadius: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, transition: 'all 0.2s' }}>
              Try Demo Account
            </button>
          </div>
        </div>

        {/* STATS */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14, marginBottom: 80 }}>
          {[['CSV / Excel','Also JSON and Parquet'],['Up to 16','Dataset-dependent charts'],['5','Core deliverables'],['Optional','ML baselines']].map(([n,l])=>(
            <div key={l} style={G.panel({ padding: '24px', textAlign: 'center' })}>
              <div style={{ fontSize: 34, fontWeight: 900, background: 'linear-gradient(135deg,#8B7CF8,#5ECFB2)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', letterSpacing: '-1px', marginBottom: 6 }}>{n}</div>
              <div style={{ fontSize: 13, color: C.muted, fontWeight: 500 }}>{l}</div>
            </div>
          ))}
        </div>

        {/* FEATURES */}
        <div style={{ textAlign: 'center', marginBottom: 44 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.primary, letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: 12 }}>What DS Agent Does</div>
          <h2 style={{ fontSize: 'clamp(26px,3vw,38px)', fontWeight: 800, letterSpacing: '-1px' }}>Every step. Fully automated.</h2>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 14, marginBottom: 80 }}>
          {features.map(f => (
            <div key={f.title} style={G.panel({ padding: '26px', transition: 'all 0.3s', cursor: 'default' })}
              onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-4px)'; e.currentTarget.style.background = 'rgba(255,255,255,0.09)'; e.currentTarget.style.boxShadow = '0 20px 40px rgba(0,0,0,0.3)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.boxShadow = 'none'; }}>
              <div style={{ width: 50, height: 50, borderRadius: 14, background: `${f.color}18`, border: `1px solid ${f.color}28`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, marginBottom: 16 }}>{f.icon}</div>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{f.title}</div>
              <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.65 }}>{f.desc}</div>
            </div>
          ))}
        </div>

        {/* PRICING */}
        <div id="pricing" style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.primary, letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: 12 }}>Simple monthly plans</div>
          <h2 style={{ fontSize: 'clamp(26px,3vw,38px)', fontWeight: 800, letterSpacing: '-1px' }}>Start free. Upgrade as you grow.</h2>
          <p style={{ color: C.muted, fontSize: 13, marginTop: 10 }}>One account is one seat. Paid checkout becomes available after Razorpay is configured.</p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 16, marginBottom: 80 }}>
          {Object.values(PLANS).map(plan => (
            <div key={plan.code} style={G.panel({ padding: 24, borderColor: plan.code === 'pro' ? 'rgba(139,124,248,0.45)' : C.border })}>
              <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 8 }}>{plan.name}</div>
              <div style={{ fontSize: 28, fontWeight: 900, marginBottom: 4 }}>
                {plan.priceInr === 0 ? 'Free' : `₹${plan.priceInr.toLocaleString('en-IN')}`}
                {plan.priceInr > 0 && <span style={{ color: C.muted, fontSize: 12, fontWeight: 500 }}> / seat / month</span>}
              </div>
              <p style={{ minHeight: 38, color: C.muted, fontSize: 13 }}>{plan.description}</p>
              <ul style={{ minHeight: 118, paddingLeft: 18, color: C.muted, fontSize: 13, lineHeight: 1.8 }}>
                {plan.features.map(feature => <li key={feature}>{feature}</li>)}
              </ul>
              <button onClick={() => nav('/signup')} style={{ ...G.btn(plan.code === 'pro' ? 'linear-gradient(135deg,#8B7CF8,#6B5CE7)' : 'rgba(255,255,255,0.08)'), width: '100%' }}>
                {plan.code === 'free' ? 'Start free' : 'Create account'}
              </button>
            </div>
          ))}
        </div>

        {/* PIPELINE */}
        <div style={{ textAlign: 'center', marginBottom: 44 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.teal, letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: 12 }}>Pipeline</div>
          <h2 style={{ fontSize: 'clamp(26px,3vw,38px)', fontWeight: 800, letterSpacing: '-1px' }}>How DS Agent Works</h2>
        </div>
        <div style={{ display: 'flex', gap: 0, marginBottom: 80, overflowX: 'auto', padding: '8px 0' }}>
          {steps.map((s, i) => (
            <div key={s.title} style={{ flex: 1, textAlign: 'center', padding: '0 16px', minWidth: 140 }}>
              <div style={{ width: 60, height: 60, borderRadius: '50%', background: 'rgba(139,124,248,0.1)', border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, margin: '0 auto 14px' }}>{s.icon}</div>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{s.title}</div>
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.55 }}>{s.desc}</div>
            </div>
          ))}
        </div>

        {/* DELIVERABLES */}
        <div style={{ ...G.panel({ padding: '40px', marginBottom: 80, background: 'rgba(139,124,248,0.05)', borderColor: 'rgba(139,124,248,0.15)' }) }}>
          <h3 style={{ fontSize: 22, fontWeight: 800, marginBottom: 8, letterSpacing: '-0.5px' }}>Five Core Analysis Deliverables 📦</h3>
          <p style={{ color: C.muted, fontSize: 14, marginBottom: 28 }}>Each analysis generates these outputs. ML runs also include a model comparison report.</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
            {[['🗂️','cleaned_data.csv','Processed Dataset'],['📋','eda_report.md','Statistical Report'],['💡','insights_report.md','Data Insights'],['🎨','/visualizations/','Up to 16 PNG charts'],['📓','analysis_notebook.ipynb','Jupyter Notebook']].map(([icon,name,type])=>(
              <div key={name} style={{ background: 'rgba(255,255,255,0.05)', border: `1px solid ${C.border}`, borderRadius: 12, padding: '16px', display: 'flex', alignItems: 'center', gap: 12, transition: 'all 0.2s', cursor: 'default' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(139,124,248,0.1)'; e.currentTarget.style.borderColor = 'rgba(139,124,248,0.3)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor = C.border; }}>
                <span style={{ fontSize: 22 }}>{icon}</span>
                <div><div style={{ fontSize: 12, fontWeight: 600 }}>{name}</div><div style={{ fontSize: 10, color: C.muted }}>{type}</div></div>
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <div style={{ background: 'linear-gradient(135deg,rgba(139,124,248,0.1),rgba(94,207,178,0.07))', border: `1px solid rgba(139,124,248,0.18)`, borderRadius: 28, padding: '60px 40px', textAlign: 'center', marginBottom: 60 }}>
          <h2 style={{ fontSize: 'clamp(26px,3vw,44px)', fontWeight: 900, letterSpacing: '-1px', marginBottom: 14 }}>Ready to analyze your data?</h2>
          <p style={{ color: C.muted, fontSize: 16, marginBottom: 32, maxWidth: 420, margin: '0 auto 32px', lineHeight: 1.7 }}>Build repeatable analysis workflows with automated reports, visualizations, and ML baselines.</p>
          <button onClick={() => nav('/signup')} style={{ ...G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)'), fontSize: 15, padding: '14px 40px', boxShadow: '0 6px 32px rgba(139,124,248,0.3)', borderRadius: 13 }}>
            Start for Free — No Credit Card
          </button>
        </div>
      </div>

      <footer style={{ borderTop: `1px solid ${C.border}`, padding: '24px', textAlign: 'center', color: C.muted, fontSize: 13 }}>
        <span style={{ background: 'linear-gradient(135deg,#8B7CF8,#5ECFB2)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', fontWeight: 700 }}>✦ DS Agent</span>
        &nbsp;· Autonomous Data Science Platform · Built with ❤️
      </footer>
    </div>
  );
}
