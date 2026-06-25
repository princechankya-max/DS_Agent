import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';
import Sidebar from '../components/Sidebar.jsx';
import Aurora from '../components/Aurora.jsx';
import { upload as uploadApi, analysis as analysisApi } from '../utils/api.js';
import { C, G, GLOBAL_CSS } from '../utils/design.js';

const STEPS = ['Upload File', 'Configure', 'Analyze'];

export default function NewAnalysis() {
  const nav = useNavigate();
  const fileRef = useRef();
  const [step, setStep] = useState(0);
  const [file, setFile] = useState(null);
  const [fileInfo, setFileInfo] = useState(null);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [name, setName] = useState('');
  const [analysisType, setAnalysisType] = useState('eda');
  const [targetCol, setTargetCol] = useState('');
  const [progress, setProgress] = useState([]);
  const [progressPct, setProgressPct] = useState(0);
  const [jobId, setJobId] = useState(null);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');
  const [drag, setDrag] = useState(false);

  const handleFile = async (f) => {
    if (!f) return;
    const ext = f.name.split('.').pop().toLowerCase();
    if (!['csv','xlsx','xls','json','parquet'].includes(ext)) { setErr('File type not supported'); return; }
    setFile(f);
    setName(f.name.replace(/\.[^.]+$/, ''));
    setErr('');

    // Upload
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await uploadApi.file(fd, setUploadPct);
      setFileInfo(res.data);
      setStep(1);
    } catch (e) { setErr(e.response?.data?.error || 'Upload failed'); }
    setUploading(false);
  };

  const startAnalysis = async () => {
    setStep(2);
    setProgress([{ icon: '📁', msg: 'File validated', done: true }]);
    try {
      const res = await analysisApi.create({
        name, file_path: fileInfo.path, original_name: fileInfo.original_name,
        file_size: fileInfo.size, analysis_type: analysisType, target_col: targetCol || null,
      });
      const jid = res.data.job_id;
      setJobId(jid);

      // Listen for progress
      const socket = io('/', { transports: ['polling'] });
      socket.emit('join-job', jid);
      socket.on('progress', ({ step: pStep, pct, msg }) => {
        setProgressPct(pct);
        setProgress(prev => {
          const exists = prev.find(p => p.msg === msg);
          if (exists) return prev;
          return [...prev, { icon: pct === 100 ? '✓' : '⟳', msg, done: pct === 100 }];
        });
        if (pct >= 100) { setDone(true); socket.disconnect(); }
      });

      // Fallback polling
      const poll = setInterval(async () => {
        try {
          const s = await analysisApi.get(jid);
          if (s.data.status === 'completed') { setDone(true); setProgressPct(100); clearInterval(poll); }
          if (s.data.status === 'failed') { setErr(s.data.error_msg || 'Analysis failed'); clearInterval(poll); }
        } catch {}
      }, 3000);
    } catch (e) { setErr(e.response?.data?.error || 'Failed to start analysis'); }
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'system-ui,-apple-system,sans-serif', color: C.text, display: 'flex' }}>
      <style>{GLOBAL_CSS}</style>
      <Aurora />
      <div style={{ width: 220, minHeight: '100vh', padding: '16px 10px', position: 'sticky', top: 0, height: '100vh', flexShrink: 0, zIndex: 10 }}>
        <Sidebar />
      </div>

      <div style={{ flex: 1, padding: '28px', position: 'relative', zIndex: 1 }}>
        <div style={{ maxWidth: 680, margin: '0 auto' }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 24, letterSpacing: '-0.5px' }}>✦ New Analysis</h1>

          {/* Step Progress */}
          <div style={{ display: 'flex', gap: 0, marginBottom: 36 }}>
            {STEPS.map((s, i) => (
              <div key={s} style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: i <= step ? 'linear-gradient(135deg,#8B7CF8,#6B5CE7)' : 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0, transition: 'all 0.3s' }}>{i < step ? '✓' : i+1}</div>
                  <span style={{ fontSize: 13, fontWeight: i === step ? 600 : 400, color: i <= step ? C.text : C.muted }}>{s}</span>
                </div>
                {i < STEPS.length-1 && <div style={{ flex: 1, height: 1, background: i < step ? C.primary : C.border, margin: '0 12px', transition: 'all 0.3s' }} />}
              </div>
            ))}
          </div>

          {err && <div style={{ background: 'rgba(255,83,112,0.1)', border: '1px solid rgba(255,83,112,0.3)', borderRadius: 12, padding: '12px 16px', fontSize: 13, color: '#FF8098', marginBottom: 16 }}>{err}</div>}

          {/* STEP 0 — UPLOAD */}
          {step === 0 && (
            <div
              onDrop={e => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}
              onDragOver={e => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onClick={() => fileRef.current?.click()}
              style={{ ...G.panelMd({ padding: '60px 40px', textAlign: 'center', cursor: 'pointer', border: drag ? `2px dashed ${C.primary}` : `2px dashed ${C.border}`, background: drag ? 'rgba(139,124,248,0.1)' : 'rgba(255,255,255,0.03)', transition: 'all 0.25s' }) }}>
              {uploading ? (
                <div>
                  <div style={{ fontSize: 40, marginBottom: 16 }}>📤</div>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Uploading...</div>
                  <div style={{ background: C.dim, borderRadius: 8, height: 6, overflow: 'hidden', maxWidth: 300, margin: '0 auto' }}>
                    <div style={{ background: 'linear-gradient(90deg,#8B7CF8,#5ECFB2)', height: '100%', width: `${uploadPct}%`, borderRadius: 8, transition: 'width 0.3s' }} />
                  </div>
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>{uploadPct}%</div>
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 48, marginBottom: 14 }}>{drag ? '📂' : '📤'}</div>
                  <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>{drag ? 'Drop it!' : 'Drop your dataset here'}</div>
                  <div style={{ fontSize: 13, color: C.muted, marginBottom: 20 }}>CSV, Excel, JSON, Parquet · Up to 100MB</div>
                  <button style={G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)', false)} onClick={e => { e.stopPropagation(); fileRef.current?.click(); }}>Browse Files</button>
                  <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,.json,.parquet" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
                </>
              )}
            </div>
          )}

          {/* STEP 1 — CONFIGURE */}
          {step === 1 && (
            <div style={{ animation: 'fadeUp 0.4s ease' }}>
              <div style={{ ...G.panel({ padding: '16px 20px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 14 }) }}>
                <span style={{ fontSize: 28 }}>📄</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{fileInfo?.original_name}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>{(fileInfo?.size/1024/1024).toFixed(2)} MB · Validated ✓</div>
                </div>
                <span style={{ marginLeft: 'auto', ...G.pill(C.teal) }}>✓ Ready</span>
              </div>

              <div style={G.panel({ padding: '24px' })}>
                <div style={{ marginBottom: 18 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: C.muted, letterSpacing: '0.3px', textTransform: 'uppercase', display: 'block', marginBottom: 8 }}>Analysis Name</label>
                  <input value={name} onChange={e => setName(e.target.value)} style={{ background: 'rgba(255,255,255,0.05)', border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, fontSize: 14, padding: '11px 14px', width: '100%', fontFamily: 'inherit', outline: 'none' }} />
                </div>

                <div style={{ marginBottom: 18 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: C.muted, letterSpacing: '0.3px', textTransform: 'uppercase', display: 'block', marginBottom: 8 }}>Analysis Type</label>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {[['eda', '📊 EDA Only'], ['eda_ml', '🤖 EDA + ML'], ['full', '⚡ Full Pipeline']].map(([val, label]) => (
                      <button key={val} onClick={() => setAnalysisType(val)} style={{ flex: 1, padding: '11px', border: '1px solid', borderColor: analysisType === val ? C.primary : C.border, borderRadius: 10, background: analysisType === val ? 'rgba(139,124,248,0.15)' : 'transparent', color: analysisType === val ? '#C4B9FF' : C.muted, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s' }}>{label}</button>
                    ))}
                  </div>
                </div>

                {(analysisType === 'eda_ml' || analysisType === 'full') && (
                  <div style={{ marginBottom: 18 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: C.muted, letterSpacing: '0.3px', textTransform: 'uppercase', display: 'block', marginBottom: 8 }}>Target Column (for ML)</label>
                    <input value={targetCol} onChange={e => setTargetCol(e.target.value)} placeholder="e.g. price, churn, category..." style={{ background: 'rgba(255,255,255,0.05)', border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, fontSize: 14, padding: '11px 14px', width: '100%', fontFamily: 'inherit', outline: 'none' }} />
                  </div>
                )}

                <button onClick={startAnalysis} style={{ ...G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)'), width: '100%', fontSize: 14, padding: '13px', borderRadius: 12 }}>
                  🚀 Start Analysis
                </button>
              </div>
            </div>
          )}

          {/* STEP 2 — PROGRESS */}
          {step === 2 && (
            <div style={{ animation: 'fadeUp 0.4s ease' }}>
              <div style={G.panel({ padding: '32px' })}>
                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 8 }}>
                    <span style={{ fontWeight: 600 }}>Analysis Progress</span>
                    <span style={{ color: C.primary }}>{progressPct}%</span>
                  </div>
                  <div style={{ background: C.dim, borderRadius: 8, height: 8, overflow: 'hidden' }}>
                    <div style={{ background: 'linear-gradient(90deg,#8B7CF8,#5ECFB2)', height: '100%', width: `${progressPct}%`, borderRadius: 8, transition: 'width 0.5s ease' }} />
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {progress.map((p, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: 'rgba(255,255,255,0.04)', borderRadius: 10 }}>
                      <span style={{ fontSize: 16 }}>{p.done ? '✓' : '⟳'}</span>
                      <span style={{ fontSize: 13, color: p.done ? C.text : C.muted }}>{p.msg}</span>
                    </div>
                  ))}
                  {!done && progress.length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: 'rgba(255,255,255,0.02)', borderRadius: 10 }}>
                      <div style={{ width: 16, height: 16, border: '2px solid rgba(139,124,248,0.3)', borderTopColor: C.primary, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                      <span style={{ fontSize: 13, color: C.muted }}>Working...</span>
                    </div>
                  )}
                </div>

                {done && (
                  <div style={{ marginTop: 24, textAlign: 'center' }}>
                    <div style={{ fontSize: 40, marginBottom: 12 }}>🎉</div>
                    <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Analysis Complete!</div>
                    <button onClick={() => nav(`/dashboard/analysis/${jobId}`)} style={{ ...G.btn('linear-gradient(135deg,#5ECFB2,#059669)'), fontSize: 14, padding: '12px 32px', borderRadius: 12 }}>
                      View Results →
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
