import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

// Attach JWT
api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('ds_access_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
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
          const res = await axios.post('/api/auth/refresh', { refresh_token: refresh });
          localStorage.setItem('ds_access_token', res.data.access_token);
          localStorage.setItem('ds_refresh_token', res.data.refresh_token);
          err.config.headers.Authorization = `Bearer ${res.data.access_token}`;
          return api(err.config);
        } catch {
          localStorage.clear();
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
  logout: () => api.post('/auth/logout'),
  me: () => api.get('/auth/me'),
  verifyEmail: (token) => api.post('/auth/verify-email', { token }),
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
  downloadUrl: (id, file) => `/api/analysis/${id}/download/${file}`,
};

export default api;
