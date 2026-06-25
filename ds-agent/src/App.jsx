import { useState, useEffect, createContext, useContext } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { auth as authApi } from './utils/api.js';
import Landing from './pages/Landing.jsx';
import SignIn from './pages/SignIn.jsx';
import SignUp from './pages/SignUp.jsx';
import Dashboard from './pages/Dashboard.jsx';
import NewAnalysis from './pages/NewAnalysis.jsx';
import Results from './pages/Results.jsx';
import Projects from './pages/Projects.jsx';

// ── Auth Context ──
export const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('ds_access_token');
    if (token) {
      authApi.me().then(r => setUser(r.data.user)).catch(() => {
        localStorage.removeItem('ds_access_token');
        localStorage.removeItem('ds_refresh_token');
      }).finally(() => setLoading(false));
    } else setLoading(false);
  }, []);

  const login = (userData, accessToken, refreshToken) => {
    localStorage.setItem('ds_access_token', accessToken);
    localStorage.setItem('ds_refresh_token', refreshToken);
    setUser(userData);
  };

  const logout = async () => {
    try { await authApi.logout(); } catch {}
    localStorage.clear();
    setUser(null);
  };

  if (loading) return (
    <div style={{ minHeight: '100vh', background: '#05060F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 32, marginBottom: 16, animation: 'spin 1s linear infinite', display: 'inline-block' }}>✦</div>
        <p style={{ color: '#8891AA', fontFamily: 'system-ui', fontSize: 14 }}>Loading DS Agent...</p>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    </div>
  );

  return <AuthCtx.Provider value={{ user, login, logout }}>{children}</AuthCtx.Provider>;
}

function PrivateRoute({ children }) {
  const { user } = useAuth();
  return user ? children : <Navigate to="/signin" replace />;
}

function PublicRoute({ children }) {
  const { user } = useAuth();
  return !user ? children : <Navigate to="/dashboard" replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/signin" element={<PublicRoute><SignIn /></PublicRoute>} />
          <Route path="/signup" element={<PublicRoute><SignUp /></PublicRoute>} />
          <Route path="/dashboard" element={<PrivateRoute><Dashboard /></PrivateRoute>} />
          <Route path="/dashboard/new" element={<PrivateRoute><NewAnalysis /></PrivateRoute>} />
          <Route path="/dashboard/analysis/:id" element={<PrivateRoute><Results /></PrivateRoute>} />
          <Route path="/dashboard/projects" element={<PrivateRoute><Projects /></PrivateRoute>} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
