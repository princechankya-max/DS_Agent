import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import Sidebar from '../components/Sidebar.jsx';
import Aurora from '../components/Aurora.jsx';
import { analysis as analysisApi } from '../utils/api.js';
import { C, G, GLOBAL_CSS, PALETTE } from '../utils/design.js';

const TT = { contentStyle: { background: '#0E1020', border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, fontSize: 12 } };

function TabBar({ tabs, active, onSelect }) {
  return (
    <div style={{ display: 'flex', gap: 3, padding: 4, background: 'rgba(0,0,0,0.4)', borderRadius: 12, marginBottom: 22, overflowX: 'auto' }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => onSelect(t.id)} style={{ flex: '1 0 auto', padding: '9px 14px', border: 'none', borderRadius: 10, background: active === t.id ? 'linear-gradient(135deg,#8B7CF8,#6B5CE7)' : 'transparent', color: active === t.id ? '#fff' : C.muted, fontSize: 12, fontWeight: active === t.id ? 700 : 500, cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 0.18s', fontFamily: 'inherit' }}>
          {t.icon} {t.label}
        </button>
      ))}
    </div>
  );
}

function Section({ title, children, style = {} }) {
  return (
    <div style={{ ...G.panel({ padding: '22px' }), ...style }}>
      {title && <h3 style={{ fontSize: 12, fontWeight: 700, color: C.muted, marginBottom: 16, textTransform: 'uppercase', letterSpacing: '0.6px' }}>{title}</h3>}
      {children}
    </div>
  );
}

function InsightText({ text }) {
  return String(text).split(/(\*\*.*?\*\*)/g).map((part, index) => (
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={index} style={{ color: '#EEF0FF' }}>{part.slice(2, -2)}</strong>
      : part
  ));
}

function AuthenticatedImage({ id, file, alt }) {
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl;
    setSrc('');
    setFailed(false);
    analysisApi.visualization(id, file).then(({ data: blob }) => {
      objectUrl = URL.createObjectURL(blob);
      if (!cancelled) setSrc(objectUrl);
      else URL.revokeObjectURL(objectUrl);
    }).catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, file]);

  if (failed) return <div style={{ color: C.muted, fontSize: 12 }}>Visualization unavailable</div>;
  if (!src) return <div style={{ color: C.muted, fontSize: 12 }}>Loading visualization...</div>;
  return <img src={src} alt={alt} style={{ width: '100%', borderRadius: 10, objectFit: 'cover' }} />;
}

function DownloadButton({ id, file, visualization = false, children, style }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleDownload = async () => {
    setLoading(true);
    setError('');
    try {
      const { data: blob } = visualization
        ? await analysisApi.visualization(id, file)
        : await analysisApi.download(id, file);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = file;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {
      setError('Download failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button onClick={handleDownload} disabled={loading} style={style}>
        {loading ? 'Preparing...' : children}
      </button>
      {error && <div style={{ color: C.coral, fontSize: 11, marginTop: 6 }}>{error}</div>}
    </div>
  );
}

export default function Results() {
  const { id } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [question, setQuestion] = useState('');
  const [dataConsent, setDataConsent] = useState(false);
  const [questionJobId, setQuestionJobId] = useState('');
  const [questionStatus, setQuestionStatus] = useState('');
  const [questionResult, setQuestionResult] = useState(null);
  const [questionError, setQuestionError] = useState('');
  const [questionSending, setQuestionSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timeout;
    const fetch = async () => {
      try {
        const res = await analysisApi.get(id);
        if (cancelled) return;
        setData(res.data);
        if (res.data.status === 'running' || res.data.status === 'queued') {
          timeout = setTimeout(fetch, 3000);
        }
      } catch {
        if (!cancelled) setErr('Analysis not found');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetch();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [id]);

  useEffect(() => {
    if (!questionJobId) return undefined;
    let cancelled = false;
    let timeout;
    const pollQuestion = async () => {
      try {
        const { data: job } = await analysisApi.getQuestion(id, questionJobId);
        if (cancelled) return;
        setQuestionStatus(job.status);
        if (job.status === 'completed') {
          setQuestionResult(job.result);
          return;
        }
        if (job.status === 'failed') {
          setQuestionError(job.error || 'AI Analyst could not answer this question.');
          return;
        }
        timeout = setTimeout(pollQuestion, 1500);
      } catch (error) {
        if (!cancelled) setQuestionError(error.response?.data?.error || 'Could not load the AI Analyst response.');
      }
    };
    pollQuestion();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [id, questionJobId]);

  const submitQuestion = async event => {
    event.preventDefault();
    setQuestionError('');
    setQuestionResult(null);
    setQuestionJobId('');
    setQuestionStatus('');
    setQuestionSending(true);
    try {
      const { data: job } = await analysisApi.ask(id, question, dataConsent);
      setQuestionJobId(job.job_id);
      setQuestionStatus(job.status);
    } catch (error) {
      setQuestionError(error.response?.data?.error || 'Could not submit the AI Analyst question.');
    } finally {
      setQuestionSending(false);
    }
  };

  const TABS = [
    { id: 'overview', icon: '📊', label: 'Overview' },
    { id: 'profile', icon: '🔍', label: 'Data Profile' },
    { id: 'charts', icon: '🎨', label: 'Visualizations' },
    { id: 'insights', icon: '💡', label: 'Insights' },
    { id: 'ml', icon: '🤖', label: 'Machine Learning' },
    { id: 'analyst', icon: '✨', label: 'AI Analyst' },
    { id: 'download', icon: '📥', label: 'Download' },
  ];

  if (loading) return (
    <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui', color: C.text }}>
      <style>{GLOBAL_CSS}</style>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 32, animation: 'spin 1s linear infinite', display: 'inline-block', marginBottom: 16 }}>✦</div>
        <p style={{ color: C.muted }}>Loading analysis...</p>
      </div>
    </div>
  );

  if (err) return (
    <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui', color: C.text }}>
      <style>{GLOBAL_CSS}</style>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>❌</div>
        <p style={{ color: C.coral }}>{err}</p>
        <button onClick={() => nav('/dashboard')} style={{ ...G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)', true), marginTop: 16 }}>Back to Dashboard</button>
      </div>
    </div>
  );

  const result = data?.result;
  const isRunning = data?.status === 'running' || data?.status === 'queued';

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'system-ui,-apple-system,sans-serif', color: C.text, display: 'flex' }}>
      <style>{GLOBAL_CSS}</style>
      <Aurora />
      <div style={{ width: 220, minHeight: '100vh', padding: '16px 10px', position: 'sticky', top: 0, height: '100vh', flexShrink: 0, zIndex: 10 }}>
        <Sidebar />
      </div>

      <div style={{ flex: 1, padding: '28px', position: 'relative', zIndex: 1, overflowX: 'hidden' }}>
        <div style={{ marginBottom: 22, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <button onClick={() => nav('/dashboard')} style={{ background: 'transparent', border: `1px solid ${C.border}`, color: C.muted, borderRadius: 8, padding: '6px 14px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', marginBottom: 10 }}>← Back</button>
            <h1 style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.5px' }}>{data?.name}</h1>
            <p style={{ fontSize: 12, color: C.muted }}>{data?.original_name} · {data?.status === 'completed' ? `Completed ${new Date(data.completed_at*1000).toLocaleString()}` : data?.status}</p>
          </div>
          {result?.quality_score && (
            <div style={{ ...G.panel({ padding: '14px 20px', textAlign: 'center', background: 'rgba(94,207,178,0.08)', borderColor: 'rgba(94,207,178,0.2)' }) }}>
              <div style={{ fontSize: 26, fontWeight: 900, color: C.teal, letterSpacing: '-1px' }}>{result.quality_score}/100</div>
              <div style={{ fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Quality Score</div>
            </div>
          )}
        </div>

        {isRunning && (
          <div style={{ ...G.panel({ padding: '20px', marginBottom: 20, background: 'rgba(245,201,122,0.08)', borderColor: 'rgba(245,201,122,0.25)' }), display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 20, height: 20, border: `2px solid rgba(245,201,122,0.3)`, borderTopColor: C.amber, borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
            <span style={{ fontSize: 13, color: C.amber }}>Analysis is running... Page will update automatically.</span>
          </div>
        )}

        {data?.status === 'failed' && (
          <div style={{ ...G.panel({ padding: '20px', marginBottom: 20, background: 'rgba(255,83,112,0.08)', borderColor: 'rgba(255,83,112,0.25)' }) }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.coral, marginBottom: 6 }}>Analysis failed</div>
            <div style={{ fontSize: 12, color: C.muted, whiteSpace: 'pre-wrap' }}>{data.error_msg || 'The analysis could not be completed.'}</div>
          </div>
        )}

        <TabBar tabs={TABS} active={tab} onSelect={setTab} />

        {/* OVERVIEW TAB */}
        {tab === 'overview' && result && (
          <div style={{ animation: 'fadeUp 0.4s ease' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginBottom: 20 }}>
              {[
                ['Rows Before', result.shape_before?.[0]?.toLocaleString(), C.primary],
                ['Rows After', result.shape_after?.[0]?.toLocaleString(), C.teal],
                ['Columns', result.shape_after?.[1], C.amber],
                ['Numeric', result.num_cols?.length, C.primary],
                ['Categorical', result.cat_cols?.length, C.rose],
                ['Quality Score', `${result.quality_score}/100`, C.teal],
              ].map(([l,v,c]) => (
                <div key={l} style={G.panel({ padding: '16px', background: `${c}10`, borderColor: `${c}22`, textAlign: 'center' })}>
                  <div style={{ fontSize: 22, fontWeight: 900, color: c, letterSpacing: '-0.5px', marginBottom: 3 }}>{v ?? '—'}</div>
                  <div style={{ fontSize: 10, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{l}</div>
                </div>
              ))}
            </div>

            {result.clean_log?.length > 0 && (
              <Section title="🧹 Cleaning Log" style={{ marginBottom: 16 }}>
                {result.clean_log.map((log, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: i < result.clean_log.length-1 ? `1px solid ${C.border}` : 'none', fontSize: 13 }}>
                    <span style={{ color: C.teal, flexShrink: 0 }}>✓</span>
                    <span style={{ color: '#C4CDD9' }}>{log}</span>
                  </div>
                ))}
              </Section>
            )}

            {result.insights?.length > 0 && (
              <Section title="💡 Key Insights Preview">
                {result.insights.slice(0, 4).map((ins, i) => (
                  <div key={i} style={{ padding: '10px 14px', background: 'rgba(139,124,248,0.06)', border: `1px solid rgba(139,124,248,0.15)`, borderRadius: 10, marginBottom: 8, fontSize: 13, color: '#C4CDD9', lineHeight: 1.6 }}>
                  <span style={{ color: C.primary, fontWeight: 700 }}>{i+1}.</span> <span><InsightText text={ins} /></span>
                  </div>
                ))}
              </Section>
            )}
          </div>
        )}

        {/* PROFILE TAB */}
        {tab === 'profile' && result?.stats && (
          <div style={{ animation: 'fadeUp 0.4s ease' }}>
            <Section title="📈 Numeric Columns" style={{ marginBottom: 16, overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    {['Column','Mean','Median','Std Dev','Min','Max','Skew','Nulls'].map(h=>(
                      <th key={h} style={{ padding: '8px 12px', fontSize: 10, color: C.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.3px', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.num_cols?.map((col, i) => {
                    const s = result.stats[col];
                    if (!s) return null;
                    return (
                      <tr key={col} style={{ borderBottom: `1px solid ${C.border}`, background: i%2 ? 'rgba(255,255,255,0.015)' : 'transparent' }}>
                        <td style={{ padding: '9px 12px', fontWeight: 600, fontSize: 13 }}>{col}</td>
                        {[s.mean,s.median,s.std,s.min,s.max,s.skewness].map((v,vi)=>(
                          <td key={vi} style={{ padding: '9px 12px', fontSize: 12, color: '#AAB8C8' }}>{v}</td>
                        ))}
                        <td style={{ padding: '9px 12px', fontSize: 12, color: s.null_count > 0 ? C.coral : C.teal }}>{s.null_count}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Section>

            {result.cat_cols?.length > 0 && (
              <Section title="🏷️ Categorical Columns" style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                      {['Column','Unique','Mode','Count','Nulls'].map(h=>(
                        <th key={h} style={{ padding: '8px 12px', fontSize: 10, color: C.muted, fontWeight: 700, textTransform: 'uppercase' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.cat_cols.map((col, i) => {
                      const s = result.stats[col];
                      if (!s) return null;
                      return (
                        <tr key={col} style={{ borderBottom: `1px solid ${C.border}`, background: i%2 ? 'rgba(255,255,255,0.015)' : 'transparent' }}>
                          <td style={{ padding: '9px 12px', fontWeight: 600, fontSize: 13 }}>{col}</td>
                          <td style={{ padding: '9px 12px', fontSize: 12, color: '#AAB8C8' }}>{s.unique}</td>
                          <td style={{ padding: '9px 12px', fontSize: 12, color: '#AAB8C8', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.mode}</td>
                          <td style={{ padding: '9px 12px', fontSize: 12, color: '#AAB8C8' }}>{s.count?.toLocaleString()}</td>
                          <td style={{ padding: '9px 12px', fontSize: 12, color: s.null_count > 0 ? C.coral : C.teal }}>{s.null_count}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Section>
            )}
          </div>
        )}

        {/* CHARTS TAB */}
        {tab === 'charts' && (
          <div style={{ animation: 'fadeUp 0.4s ease' }}>
            {result?.viz_info?.length > 0 ? (
              <div>
                <p style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>{result.viz_info.length} charts generated. Images served from backend.</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 14 }}>
                  {result.viz_info.map((v, i) => (
                    <div key={i} style={G.panel({ padding: '16px', overflow: 'hidden' })}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 10 }}>{v.name}</div>
                      <AuthenticatedImage id={id} file={v.path.split(/[\\/]/).pop()} alt={v.name} />
                      <DownloadButton id={id} file={v.path.split(/[\\/]/).pop()} visualization style={{ display: 'block', width: '100%', marginTop: 8, background: 'transparent', border: 0, color: C.primary, cursor: 'pointer', fontSize: 11 }}>⬇ Download</DownloadButton>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <Section>
                <div style={{ textAlign: 'center', padding: '40px' }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>🎨</div>
                  <div style={{ color: C.muted, fontSize: 14 }}>{isRunning ? 'Visualizations being generated...' : 'No visualizations available yet'}</div>
                </div>
              </Section>
            )}
          </div>
        )}

        {/* INSIGHTS TAB */}
        {tab === 'insights' && (
          <div style={{ animation: 'fadeUp 0.4s ease' }}>
            {result?.insights ? (
              <Section title="💡 Data Insights">
                {result.insights.length === 0 ? (
                  <p style={{ color: C.muted, fontSize: 13 }}>✅ No major data issues detected. Data looks clean!</p>
                ) : result.insights.map((ins, i) => (
                  <div key={i} style={{ padding: '14px 16px', background: 'rgba(139,124,248,0.06)', border: `1px solid rgba(139,124,248,0.15)`, borderRadius: 12, marginBottom: 10, fontSize: 13, color: '#C4CDD9', lineHeight: 1.7 }}>
                    <strong style={{ color: C.primary, marginRight: 8 }}>{i+1}.</strong>
                    <span><InsightText text={ins} /></span>
                  </div>
                ))}
              </Section>
            ) : (
              <Section><div style={{ textAlign: 'center', padding: '40px', color: C.muted }}>{isRunning ? 'Generating insights...' : 'No insights available'}</div></Section>
            )}
          </div>
        )}

        {tab === 'ml' && (
          <div style={{ animation: 'fadeUp 0.4s ease' }}>
            {!result?.ml || result.ml.status === 'not_requested' ? (
              <Section>
                <div style={{ textAlign: 'center', padding: 32, color: C.muted }}>Choose EDA + ML or Full Pipeline and provide a target column to compare models.</div>
              </Section>
            ) : result.ml.status === 'skipped' ? (
              <Section title="🤖 Machine Learning">
                <p style={{ color: C.amber, fontSize: 13 }}>{result.ml.reason}</p>
              </Section>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12, marginBottom: 16 }}>
                  {[
                    ['Task', result.ml.task],
                    ['Target', result.ml.target],
                    ['Best Model', result.ml.best_model],
                    ['Train / Test Rows', `${result.ml.train_rows} / ${result.ml.test_rows}`],
                    ['Features Used', result.ml.feature_count],
                  ].map(([label, value]) => (
                    <div key={label} style={G.panel({ padding: 16, textAlign: 'center' })}>
                      <div style={{ fontSize: 16, fontWeight: 800, color: C.primary, marginBottom: 4, textTransform: 'capitalize' }}>{value}</div>
                      <div style={{ fontSize: 10, color: C.muted, textTransform: 'uppercase' }}>{label}</div>
                    </div>
                  ))}
                </div>
                <Section title={`Model Comparison · selected by ${result.ml.selection_metric}`}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
                    {result.ml.models.map(model => (
                      <div key={model.name} style={G.panel({ padding: 16, borderColor: model.name === result.ml.best_model ? 'rgba(94,207,178,0.35)' : C.border })}>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>{model.name}{model.name === result.ml.best_model ? ' · Best' : ''}</div>
                        {model.metrics ? Object.entries(model.metrics).map(([metric, value]) => (
                          <div key={metric} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: C.muted, padding: '4px 0' }}>
                            <span>HOLDOUT · {metric.replace('_', ' ').toUpperCase()}</span><strong style={{ color: C.text }}>{value}</strong>
                          </div>
                        )) : <p style={{ color: C.coral, fontSize: 12 }}>{model.error}</p>}
                        {model.cv_metrics && Object.entries(model.cv_metrics).map(([metric, value]) => (
                          <div key={metric} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: C.muted, padding: '4px 0' }}>
                            <span>CV · {metric.replace('_', ' ').toUpperCase()}</span><strong style={{ color: C.text }}>{value}</strong>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                  <p style={{ color: C.muted, fontSize: 11, marginTop: 14 }}>Models are selected using cross-validation within the training split. Holdout metrics are reported separately; preprocessing is fit within each training fold. This is a baseline comparison, not a production-ready model.</p>
                </Section>
              </>
            )}
          </div>
        )}

        {tab === 'analyst' && (
          <div style={{ animation: 'fadeUp 0.4s ease' }}>
            <Section title="Ask about this dataset">
              <p style={{ color: C.muted, fontSize: 13, lineHeight: 1.6, marginBottom: 14 }}>
                Ask for summaries, category counts, grouped totals, or correlations. DS Agent validates a fixed query plan; it never executes model-generated SQL or Python.
              </p>
              <form onSubmit={submitQuestion}>
                <textarea
                  value={question}
                  onChange={event => setQuestion(event.target.value)}
                  maxLength={1000}
                  minLength={5}
                  required
                  placeholder="For example: Which regions have the highest total sales?"
                  style={{ ...G.input, width: '100%', minHeight: 96, resize: 'vertical', marginBottom: 10 }}
                />
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, color: C.muted, fontSize: 12, lineHeight: 1.5, marginBottom: 14 }}>
                  <input
                    type="checkbox"
                    checked={dataConsent}
                    onChange={event => setDataConsent(event.target.checked)}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    I agree to send my question and column names to the configured AI provider. The aggregate query result may also be sent to explain it; raw dataset rows and credentials are not sent.
                  </span>
                </label>
                <button
                  type="submit"
                  disabled={questionSending || questionStatus === 'queued' || questionStatus === 'running'}
                  style={G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)', true)}
                >
                  {questionSending ? 'Submitting...' : ['queued', 'running'].includes(questionStatus) ? 'Analyzing...' : 'Ask AI Analyst'}
                </button>
                {questionJobId && ['queued', 'running'].includes(questionStatus) && (
                  <span style={{ color: C.muted, fontSize: 12, marginLeft: 12 }}>Question {questionStatus}…</span>
                )}
              </form>
            </Section>
            {questionError && (
              <Section title="AI Analyst" style={{ marginTop: 14, borderColor: 'rgba(255,83,112,0.3)' }}>
                <p style={{ color: C.coral, fontSize: 13 }}>{questionError}</p>
              </Section>
            )}
            {questionResult && (
              <Section title="AI Analyst answer" style={{ marginTop: 14 }}>
                <p style={{ color: C.text, fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{questionResult.answer}</p>
                {questionResult.query_result?.summary && (
                  <p style={{ color: C.muted, fontSize: 12, marginTop: 12 }}>{questionResult.query_result.summary}</p>
                )}
                {questionResult.query_result?.rows?.length > 0 && (
                  <div style={{ overflowX: 'auto', marginTop: 12 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr>{Object.keys(questionResult.query_result.rows[0]).map(column => (
                          <th key={column} style={{ textAlign: 'left', padding: 8, color: C.muted, borderBottom: `1px solid ${C.border}` }}>{column.replaceAll('_', ' ')}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {questionResult.query_result.rows.map((row, index) => (
                          <tr key={index}>{Object.values(row).map((value, cellIndex) => (
                            <td key={cellIndex} style={{ padding: 8, borderBottom: `1px solid ${C.border}`, color: C.text }}>{value == null ? '—' : String(value)}</td>
                          ))}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>
            )}
          </div>
        )}

        {/* DOWNLOAD TAB */}
        {tab === 'download' && (
          <div style={{ animation: 'fadeUp 0.4s ease' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 14, marginBottom: 16 }}>
              {[
                ['🗂️', 'cleaned_data.csv', 'Processed Dataset', 'cleaned_data.csv'],
                ['📋', 'eda_report.md', 'Statistical Report', 'eda_report.md'],
                ['💡', 'insights_report.md', 'Business Insights', 'insights_report.md'],
                ['📓', 'analysis_notebook.ipynb', 'Jupyter Notebook', 'analysis_notebook.ipynb'],
                ['🤖', 'ml_report.md', 'Model Comparison', 'ml_report.md'],
              ].filter(([, , , file]) => (
                (file !== 'analysis_notebook.ipynb' || result?.files?.notebook) &&
                (file !== 'ml_report.md' || result?.files?.ml_report)
              )).map(([icon, name, desc, file]) => (
                <div key={name} style={G.panel({ padding: '22px', display: 'flex', flexDirection: 'column', gap: 12 })}>
                  <div style={{ fontSize: 32 }}>{icon}</div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{name}</div>
                    <div style={{ fontSize: 12, color: C.muted }}>{desc}</div>
                  </div>
                  <DownloadButton id={id} file={file} style={{ ...G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)', true), width: '100%' }}>⬇ Download</DownloadButton>
                </div>
              ))}
            </div>

            {result?.viz_info?.length > 0 && (
              <div style={G.panel({ padding: '22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 })}>
                <div>
                  <div style={{ fontSize: 22, marginBottom: 8 }}>🎨</div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>visualizations/ folder</div>
                  <div style={{ fontSize: 12, color: C.muted }}>{result.viz_info.length} PNG charts</div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {result.viz_info.slice(0, 3).map((v, i) => (
                    <DownloadButton key={i} id={id} file={v.path.split(/[\\/]/).pop()} visualization style={{ ...G.btn('rgba(255,255,255,0.07)', true), border: `1px solid ${C.border}`, fontSize: 11 }}>⬇ {v.name.slice(0, 15)}</DownloadButton>
                  ))}
                  {result.viz_info.length > 3 && <span style={{ color: C.muted, fontSize: 12, alignSelf: 'center' }}>+{result.viz_info.length - 3} more</span>}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
