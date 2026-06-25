# ✦ DS Agent — Autonomous Data Science Platform

> Upload any dataset → Get EDA, visualizations, insights, and ML models automatically.

---

## 🚀 Quick Setup (5 minutes)

### Prerequisites
- Node.js 18+  →  https://nodejs.org
- Python 3.8+  →  https://python.org

### Step 1 — Install Python packages
```bash
pip install pandas numpy matplotlib seaborn scikit-learn openpyxl pyarrow nbformat jupyter
```

### Step 2 — Install Node packages
```bash
npm install
```

### Step 3 — Environment setup
```bash
cp .env.example .env
# .env file mein JWT secrets customize karo (production ke liye)
```

### Step 4 — Run
```bash
npm run dev
```

Browser open karo:  **http://localhost:5173**

---

## 📁 Project Structure

```
ds-agent/
├── src/                    ← React Frontend
│   ├── App.jsx             ← Router + Auth Context
│   ├── pages/
│   │   ├── Landing.jsx     ← Marketing landing page
│   │   ├── SignIn.jsx      ← Login + SignUp + Auth forms
│   │   ├── SignUp.jsx      ← Re-export from SignIn
│   │   ├── Dashboard.jsx   ← Main dashboard
│   │   ├── NewAnalysis.jsx ← 3-step upload wizard
│   │   ├── Results.jsx     ← 5-tab results viewer
│   │   └── Projects.jsx    ← All analyses list
│   ├── components/
│   │   ├── Aurora.jsx      ← Animated background
│   │   └── Sidebar.jsx     ← Nav sidebar
│   └── utils/
│       ├── api.js          ← Axios API client + auto-refresh
│       └── design.js       ← Design tokens + style helpers
├── backend/
│   ├── server.js           ← Express + Socket.IO
│   ├── db/database.js      ← SQLite init + helpers
│   ├── middleware/auth.js  ← JWT verification
│   └── routes/
│       ├── auth.js         ← Register, Login, Refresh, Reset
│       ├── upload.js       ← File upload + magic-bytes validation
│       └── analysis.js     ← Job create, status, download
├── analysis_engine.py      ← Python EDA pipeline
├── uploads/                ← Uploaded datasets (auto-created)
├── outputs/                ← Generated reports (auto-created)
├── ds_agent.db             ← SQLite database (auto-created)
├── vite.config.js
├── index.html
├── package.json
└── .env.example
```

---

## ✨ Features

| Feature | Details |
|---|---|
| 🔐 Auth | JWT + Refresh tokens, bcrypt hashing, account lockout, rate limiting |
| 📤 Upload | CSV, Excel, JSON, Parquet · Magic-bytes validation · 100MB limit |
| 🧹 ETL | Auto null imputation, dedup, outlier capping, type fixing |
| 📊 EDA | Stats, correlations, distributions, anomaly detection |
| 🎨 Charts | 50+ PNG charts: histograms, heatmaps, boxplots, pairplots, count charts |
| 💡 Insights | Data quality score, skewness alerts, multicollinearity warnings |
| 📥 5 Outputs | cleaned_data.csv · eda_report.md · insights_report.md · /visualizations/ · notebook.ipynb |
| 🔄 Real-time | WebSocket progress updates during analysis |
| 🎨 UI | "Soft Aurora" glassmorphism dark theme |

---

## 🔒 Security

- Passwords hashed with bcrypt (12 rounds)
- JWT: 15 min access + 7 day refresh tokens
- Account lockout after 5 failed attempts
- File magic-bytes validation (not just extension)
- Rate limiting on auth endpoints
- Helmet.js security headers

---

## 📦 5 Deliverables (Every Analysis)

1. `cleaned_data.csv` — ETL-processed dataset
2. `eda_report.md` — Full statistical report in Markdown
3. `insights_report.md` — Business insights + recommendations
4. `visualizations/` — 10-15+ PNG charts (dark theme)
5. `analysis_notebook.ipynb` — Reproducible Jupyter notebook

---

## 🎨 Design: "Soft Aurora" Theme

- Background: `#05060F` (deep space)
- Primary: `#8B7CF8` (soft lavender)
- Secondary: `#5ECFB2` (soft mint)
- Accent: `#F5A8C8` (soft rose)
- Animated aurora orbs: slow 9s pulse

---

## 🚀 Production Deploy

```bash
npm run build
NODE_ENV=production node backend/server.js
```

Works on: **Railway, Render, Vercel (serverless), Replit, VPS**

---

Built with ❤️ using React + Express + SQLite + Python
✦ DS Agent — Autonomous Data Science Platform
