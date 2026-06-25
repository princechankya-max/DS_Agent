import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../App.jsx';
import { auth as authApi } from '../utils/api.js';
import Aurora from '../components/Aurora.jsx';
import { C, G, GLOBAL_CSS } from '../utils/design.js';

function AuthShell({ children, title, sub }) {
  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'system-ui,-apple-system,sans-serif', color: C.text, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <style>{GLOBAL_CSS}</style>
      <Aurora />
      <div style={{ width: '100%', maxWidth: 440, position: 'relative', zIndex: 1, animation: 'fadeUp 0.5s ease' }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <Link to="/" style={{ fontSize: 22, fontWeight: 900, background: 'linear-gradient(135deg,#8B7CF8,#5ECFB2)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>✦ DS Agent</Link>
          <h1 style={{ fontSize: 26, fontWeight: 800, marginTop: 20, marginBottom: 8, letterSpacing: '-0.8px' }}>{title}</h1>
          <p style={{ color: C.muted, fontSize: 14 }}>{sub}</p>
        </div>
        <div style={G.panelMd({ padding: '32px' })}>
          {children}
        </div>
      </div>
    </div>
  );
}

function Field({ label, type='text', value, onChange, placeholder, icon, error, extra }) {
  const [show, setShow] = useState(false);
  const isPass = type === 'password';
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: C.muted, letterSpacing: '0.3px', textTransform: 'uppercase', display: 'block', marginBottom: 7 }}>{label}</label>
      <div style={{ position: 'relative' }}>
        <input
          type={isPass ? (show ? 'text' : 'password') : type}
          value={value} onChange={onChange} placeholder={placeholder}
          style={{ ...G.input(), borderColor: error ? C.coral : C.border, paddingRight: isPass ? 44 : 16 }}
        />
        {isPass && (
          <button type="button" onClick={() => setShow(!show)} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 14 }}>{show ? '🙈' : '👁️'}</button>
        )}
      </div>
      {error && <div style={{ fontSize: 11, color: C.coral, marginTop: 5 }}>{error}</div>}
      {extra}
    </div>
  );
}

function PwStrength({ pw }) {
  const checks = [pw.length >= 8, /[A-Z]/.test(pw), /\d/.test(pw), /[!@#$%^&*]/.test(pw)];
  const score = checks.filter(Boolean).length;
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
  const colors = ['', C.coral, C.amber, C.teal, C.teal];
  if (!pw) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 5 }}>
        {[1,2,3,4].map(i => (
          <div key={i} style={{ flex: 1, height: 3, borderRadius: 3, background: i <= score ? colors[score] : C.dim, transition: 'all 0.3s' }} />
        ))}
      </div>
      <div style={{ fontSize: 11, color: colors[score], fontWeight: 600 }}>{labels[score]} {score === 4 ? '✓' : ''}</div>
    </div>
  );
}

// ── SIGN IN ──
export function SignIn() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const nav = useNavigate();

  const handleSubmit = async () => {
    if (!email || !pw) { setErr('All fields required'); return; }
    setLoading(true); setErr('');
    try {
      const res = await authApi.login({ email, password: pw });
      login(res.data.user, res.data.access_token, res.data.refresh_token || '');
      nav('/dashboard');
    } catch (e) {
      setErr(e.response?.data?.error || 'Login failed');
    }
    setLoading(false);
  };

  const demoLogin = async () => {
    setEmail('demo@dsagent.ai'); setPw('Demo@12345');
    setLoading(true); setErr('');
    try {
      const res = await authApi.login({ email: 'demo@dsagent.ai', password: 'Demo@12345' });
      login(res.data.user, res.data.access_token, '');
      nav('/dashboard');
    } catch { setErr('Demo login failed. Make sure server is running.'); }
    setLoading(false);
  };

  return (
    <AuthShell title="Welcome back" sub="Sign in to your DS Agent account">
      {err && <div style={{ background: 'rgba(255,83,112,0.1)', border: '1px solid rgba(255,83,112,0.3)', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: '#FF8098', marginBottom: 16 }}>{err}</div>}
      <Field label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
      <Field label="Password" type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Your password"
        extra={<div style={{ textAlign: 'right', marginTop: 6 }}><Link to="/forgot-password" style={{ fontSize: 12, color: C.primary }}>Forgot password?</Link></div>} />
      <button onClick={handleSubmit} disabled={loading} style={{ ...G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)'), width: '100%', fontSize: 14, padding: '13px', borderRadius: 12, marginBottom: 10, opacity: loading ? 0.7 : 1 }}>
        {loading ? 'Signing in...' : 'Sign In'}
      </button>
      <button onClick={demoLogin} style={{ width: '100%', background: 'rgba(94,207,178,0.1)', border: '1px solid rgba(94,207,178,0.25)', color: C.teal, borderRadius: 12, padding: '11px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginBottom: 20 }}>
        🧪 Try Demo Account
      </button>
      <div style={{ textAlign: 'center', fontSize: 13, color: C.muted }}>
        Don't have an account? <Link to="/signup" style={{ color: C.primary, fontWeight: 600 }}>Sign Up</Link>
      </div>
    </AuthShell>
  );
}

// ── SIGN UP ──
export function SignUp() {
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [err, setErr] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const nav = useNavigate();

  const set = (k) => (e) => setForm(p => ({ ...p, [k]: e.target.value }));

  const handleSubmit = async () => {
    if (!form.name || !form.email || !form.password) { setErr('All fields required'); return; }
    if (form.password !== form.confirm) { setErr('Passwords do not match'); return; }
    const pwOk = /^(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*]).{8,}$/.test(form.password);
    if (!pwOk) { setErr('Password must be 8+ chars with uppercase, number, and special character'); return; }
    setLoading(true); setErr('');
    try {
      await authApi.register({ name: form.name, email: form.email, password: form.password });
      setSuccess('Account created! Check your email to verify (or use the dev token in server logs).');
    } catch (e) {
      setErr(e.response?.data?.error || 'Registration failed');
    }
    setLoading(false);
  };

  if (success) return (
    <AuthShell title="Check your email" sub="">
      <div style={{ textAlign: 'center', padding: '20px 0' }}>
        <div style={{ fontSize: 52, marginBottom: 20, animation: 'float 3s ease-in-out infinite' }}>📧</div>
        <p style={{ color: C.muted, fontSize: 14, lineHeight: 1.7, marginBottom: 24 }}>{success}</p>
        <button onClick={() => nav('/signin')} style={{ ...G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)'), width: '100%', borderRadius: 12 }}>Go to Sign In</button>
      </div>
    </AuthShell>
  );

  return (
    <AuthShell title="Create your account" sub="Start your free DS Agent journey">
      {err && <div style={{ background: 'rgba(255,83,112,0.1)', border: '1px solid rgba(255,83,112,0.3)', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: '#FF8098', marginBottom: 16 }}>{err}</div>}
      <Field label="Full Name" value={form.name} onChange={set('name')} placeholder="Priyanka Sharma" />
      <Field label="Email" type="email" value={form.email} onChange={set('email')} placeholder="you@example.com" />
      <Field label="Password" type="password" value={form.password} onChange={set('password')} placeholder="Min 8 chars, uppercase, number, special"
        extra={<PwStrength pw={form.password} />} />
      <Field label="Confirm Password" type="password" value={form.confirm} onChange={set('confirm')} placeholder="Repeat password" />
      <button onClick={handleSubmit} disabled={loading} style={{ ...G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)'), width: '100%', fontSize: 14, padding: '13px', borderRadius: 12, marginBottom: 20, opacity: loading ? 0.7 : 1 }}>
        {loading ? 'Creating account...' : 'Create Account'}
      </button>
      <div style={{ textAlign: 'center', fontSize: 13, color: C.muted }}>
        Already have an account? <Link to="/signin" style={{ color: C.primary, fontWeight: 600 }}>Sign In</Link>
      </div>
    </AuthShell>
  );
}

export default SignIn;
