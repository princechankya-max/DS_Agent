import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Aurora from '../components/Aurora.jsx';
import { auth as authApi } from '../utils/api.js';
import { C, G, GLOBAL_CSS } from '../utils/design.js';

function AuthActionShell({ title, subtitle, children }) {
  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'system-ui,-apple-system,sans-serif', color: C.text, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <style>{GLOBAL_CSS}</style>
      <Aurora />
      <main style={{ width: '100%', maxWidth: 440, position: 'relative', zIndex: 1 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <Link to="/" style={{ fontSize: 22, fontWeight: 900, background: 'linear-gradient(135deg,#8B7CF8,#5ECFB2)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>✦ DS Agent</Link>
          <h1 style={{ fontSize: 26, fontWeight: 800, marginTop: 20, marginBottom: 8 }}>{title}</h1>
          <p style={{ color: C.muted, fontSize: 14 }}>{subtitle}</p>
        </div>
        <div style={G.panelMd({ padding: 32 })}>{children}</div>
      </main>
    </div>
  );
}

function EmailInput({ value, onChange }) {
  return (
    <label style={{ display: 'block', marginBottom: 16, color: C.muted, fontSize: 12, fontWeight: 600, textTransform: 'uppercase' }}>
      Email
      <input
        type="email"
        required
        autoComplete="email"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder="you@example.com"
        style={{ ...G.input(), marginTop: 7 }}
      />
    </label>
  );
}

function PasswordInput({ label, value, onChange, autoComplete }) {
  return (
    <label style={{ display: 'block', marginBottom: 16, color: C.muted, fontSize: 12, fontWeight: 600, textTransform: 'uppercase' }}>
      {label}
      <input
        type="password"
        required
        autoComplete={autoComplete}
        value={value}
        onChange={event => onChange(event.target.value)}
        style={{ ...G.input(), marginTop: 7 }}
      />
    </label>
  );
}

function Notice({ children, error = false }) {
  return (
    <p role={error ? 'alert' : 'status'} style={{ color: error ? C.coral : C.teal, fontSize: 13, lineHeight: 1.6 }}>
      {children}
    </p>
  );
}

function SubmitButton({ loading, children }) {
  return (
    <button type="submit" disabled={loading} style={{ ...G.btn('linear-gradient(135deg,#8B7CF8,#6B5CE7)'), width: '100%', borderRadius: 12, margin: '8px 0 16px', opacity: loading ? 0.7 : 1 }}>
      {loading ? 'Please wait...' : children}
    </button>
  );
}

export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState(token ? 'verifying' : 'resend');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) return undefined;
    let active = true;
    authApi.verifyEmail(token).then(response => {
      if (active) {
        setMessage(response.data.message);
        setStatus('verified');
      }
    }).catch(requestError => {
      if (active) {
        setError(requestError.response?.data?.error || 'Verification link is invalid or expired.');
        setStatus('resend');
      }
    });
    return () => { active = false; };
  }, [token]);

  const resend = async event => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await authApi.resendVerification(email);
      setMessage(response.data.message);
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Could not request a verification email.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthActionShell title={status === 'verified' ? 'Email verified' : 'Verify your email'} subtitle="Secure your DS Agent account">
      {status === 'verifying' && <Notice>Verifying your email address...</Notice>}
      {status === 'verified' && <Notice>{message}</Notice>}
      {status === 'resend' && (
        <form onSubmit={resend}>
          <p style={{ color: C.muted, fontSize: 14, lineHeight: 1.6 }}>The verification link may have expired. Request a new one below.</p>
          {error && <Notice error>{error}</Notice>}
          {message && <Notice>{message}</Notice>}
          <EmailInput value={email} onChange={setEmail} />
          <SubmitButton loading={loading}>Send verification email</SubmitButton>
        </form>
      )}
      <Link to="/signin" style={{ color: C.primary, fontSize: 13 }}>Back to sign in</Link>
    </AuthActionShell>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async event => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await authApi.forgotPassword(email);
      setMessage(response.data.message);
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Could not request a password reset.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthActionShell title="Reset your password" subtitle="We will email a secure reset link if the account exists">
      <form onSubmit={submit}>
        {error && <Notice error>{error}</Notice>}
        {message && <Notice>{message}</Notice>}
        <EmailInput value={email} onChange={setEmail} />
        <SubmitButton loading={loading}>Send reset link</SubmitButton>
      </form>
      <Link to="/signin" style={{ color: C.primary, fontSize: 13 }}>Back to sign in</Link>
    </AuthActionShell>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState(token ? '' : 'Reset link is missing or invalid.');
  const [loading, setLoading] = useState(false);

  const submit = async event => {
    event.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await authApi.resetPassword(token, password);
      setMessage(response.data.message);
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Could not reset the password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthActionShell title="Choose a new password" subtitle="Use at least 8 characters, including an uppercase letter, number, and symbol">
      {message ? (
        <>
          <Notice>{message}</Notice>
          <Link to="/signin" style={{ color: C.primary, fontSize: 13 }}>Continue to sign in</Link>
        </>
      ) : (
        <form onSubmit={submit}>
          {error && <Notice error>{error}</Notice>}
          <PasswordInput label="New password" value={password} onChange={setPassword} autoComplete="new-password" />
          <PasswordInput label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
          <SubmitButton loading={loading}>Update password</SubmitButton>
        </form>
      )}
    </AuthActionShell>
  );
}
