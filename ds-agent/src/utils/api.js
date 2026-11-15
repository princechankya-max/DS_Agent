import axios from 'axios';

const api = axios.create({ baseURL: '/api' });
let refreshPromise = null;

// Attach JWT
api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('ds_access_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  const workspaceId = localStorage.getItem('ds_workspace_id');
  if (workspaceId) cfg.headers['X-Workspace-Id'] = workspaceId;
  return cfg;
});

// Auto-refresh on 401
api.interceptors.response.use(
  r => r,
  async err => {
    if (err.response?.status === 401 && !err.config._retry) {
      err.config._retry = true;
      const refresh = localStorage.getItem('ds_refresh_token');
      if (refresh) {
        try {
          if (!refreshPromise) {
            refreshPromise = axios.post('/api/auth/refresh', { refresh_token: refresh })
              .then(response => {
                localStorage.setItem('ds_access_token', response.data.access_token);
                localStorage.setItem('ds_refresh_token', response.data.refresh_token);
                return response.data;
              })
              .finally(() => { refreshPromise = null; });
          }
          const tokens = await refreshPromise;
          err.config.headers.Authorization = `Bearer ${tokens.access_token}`;
          return api(err.config);
        } catch {
          localStorage.removeItem('ds_access_token');
          localStorage.removeItem('ds_refresh_token');
          window.location.href = '/signin';
        }
      }
    }
    return Promise.reject(err);
  }
);

export const auth = {
  register: (data) => api.post('/auth/register', data),
  login: (data) => api.post('/auth/login', data),
  logout: () => api.post('/auth/logout', { refresh_token: localStorage.getItem('ds_refresh_token') }),
  me: () => api.get('/auth/me'),
  verifyEmail: (token) => api.post('/auth/verify-email', { token }),
  resendVerification: (email) => api.post('/auth/resend-verification', { email }),
  forgotPassword: (email) => api.post('/auth/forgot-password', { email }),
  resetPassword: (token, password) => api.post('/auth/reset-password', { token, password }),
};

export const upload = {
  file: (formData, onProgress) => api.post('/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: e => onProgress?.(Math.round(e.loaded / e.total * 100)),
  }),
};

export const analysis = {
  create: (data) => api.post('/analysis', data),
  list: () => api.get('/analysis'),
  get: (id) => api.get(`/analysis/${id}`),
  delete: (id) => api.delete(`/analysis/${id}`),
  ask: (id, question, dataConsent) => api.post(`/analysis/${id}/questions`, {
    question,
    data_consent: dataConsent,
  }),
  getQuestion: (id, questionJobId) => api.get(`/analysis/${id}/questions/${encodeURIComponent(questionJobId)}`),
  download: (id, file) => api.get(`/analysis/${id}/download/${encodeURIComponent(file)}`, { responseType: 'blob' }),
  visualization: (id, file) => api.get(`/analysis/${id}/visualizations/${encodeURIComponent(file)}`, { responseType: 'blob' }),
};

export const billing = {
  plans: () => api.get('/billing/plans'),
  me: () => api.get('/billing/me'),
  subscribe: (plan_code) => api.post('/billing/subscribe', { plan_code }),
  verify: (data) => api.post('/billing/verify', data),
  cancel: () => api.post('/billing/cancel'),
  setSeats: (quantity) => api.post('/billing/seats', { quantity }),
};

export const workspaces = {
  list: () => api.get('/workspaces'),
  create: (name) => api.post('/workspaces', { name }),
  members: (workspaceId) => api.get(`/workspaces/${workspaceId}/members`),
  invite: (workspaceId, email, role = 'member') =>
    api.post(`/workspaces/${workspaceId}/invitations`, { email, role }),
  acceptInvite: (token) => api.post('/workspaces/invitations/accept', { token }),
  removeMember: (workspaceId, userId) => api.delete(`/workspaces/${workspaceId}/members/${userId}`),
};

export default api;
