# ✦ DS Agent — Autonomous Data Science Platform

> Upload any dataset → Get EDA, visualizations, insights, and ML models automatically.

---

## 🚀 Quick Setup (5 minutes)

### Prerequisites
- Node.js 20.19+  →  https://nodejs.org
- Python 3.8+  →  https://python.org
- Docker Desktop with WSL 2 (for the PostgreSQL/Redis/RustFS demo stack)

### Step 1 — Install Python packages
```bash
python -m pip install -r requirements.txt
```

### Step 2 — Install Node packages
```bash
npm install
```

### Step 3 — Configure local demo
Copy `.env.example` to `.env`. The local demo uses `DEMO_MODE=true`; payment is simulated, email is previewed by Mailpit in Compose, and the sample demo account is enabled. Demo defaults are **local-only** and must never be used on a public server. `.env` is ignored by Git.

### Step 4 — Run
```bash
npm run build
docker compose up --build -d
```

Open **http://localhost:3001**. Mail previews are at **http://localhost:8025**; RustFS's local demo console is at **http://localhost:9001**. Docker Desktop with WSL 2 is required on Windows.

To run only the SQLite development fallback without Docker, use `npm run dev` with `DEMO_MODE=true`. It uses local demo-only JWT keys and does not provide durable jobs or shared object storage. If you set `DEMO_MODE=false`, supply two different random JWT secrets of at least 32 characters.

Run the backend and ML tests with `npm test`.
The Redis-backed API-to-worker integration test is opt-in: run `AI_ANALYST_E2E=true node --test tests/aiAnalystQueue.test.js` from a container attached to the Compose network. It uses Redis database 15 by default to avoid consuming application jobs; override this with `AI_ANALYST_TEST_REDIS_URL` if needed.

## AI Analyst

Configure `AI_ANALYST_API_KEY` in the server's ignored `.env` file. `AI_ANALYST_BASE_URL` defaults to the OpenAI API; `AI_ANALYST_MODEL`, provider timeout, and local query timeout are configurable in `.env`. Never put the key in frontend code or send it in an API request. AI Analyst requires the Redis-backed worker.

The analyst accepts questions about numeric summaries, categorical value counts, grouped aggregates, and correlations. The model returns a constrained JSON operation plan; DS Agent validates its operations and columns before the Python worker executes it. Generated SQL/Python is never executed.

The user must give consent in the UI for each question. The question and column names are sent to the configured provider to create the plan, and the bounded aggregate result may be sent for its explanation. Raw dataset rows, database credentials, and provider keys are not sent.

### AI Analyst endpoints

- `POST /api/analysis/:id/questions` — queue a question for a completed analysis. JSON body: `{"question":"Which regions have the highest total sales?","data_consent":true}`. Returns `202` with a `job_id`.
- `GET /api/analysis/:id/questions/:questionJobId` — poll the question job. Returns `queued`, `running`, `completed` with the answer and aggregate result, or `failed`.

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
│   ├── server.js           ← Express API + authenticated Socket.IO
│   ├── db/database.js      ← PostgreSQL migrations + SQLite local fallback
│   ├── middleware/auth.js  ← JWT and workspace membership validation
│   ├── workers/analysis.js ← Separate durable BullMQ worker
│   ├── services/           ← Private S3 storage, queue, email and billing
│   └── routes/             ← Auth, upload, workspace, billing and analysis APIs
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
| 👥 Workspaces | Isolated workspace records, owner/admin/member roles, email invitations, billed seats |
| ✉️ Account email | Expiring verification and password-reset links delivered by SMTP |
| 📤 Upload | CSV, Excel, JSON, Parquet · Magic-bytes validation · 100MB limit |
| 🧹 ETL | Auto null imputation, dedup, outlier capping, type fixing |
| 📊 EDA | Stats, correlations, distributions, anomaly detection |
| 🎨 Charts | Up to 16 dataset-dependent distribution, category, correlation and missing-value charts |
| 💡 Insights | Data quality score, skewness alerts, multicollinearity warnings |
| 🤖 AutoML Baselines | Classification/regression workflows with imputation, scaling, categorical encoding, date features, cross-validated model selection, and separate holdout metrics |
| 📥 Outputs | Cleaned data, EDA and insights reports, charts, notebook, and optional ML report |
| 🔄 Real-time | WebSocket progress updates during analysis |
| ✨ AI Analyst | Natural-language questions mapped to validated, allowlisted dataset operations |
| 🎨 UI | "Soft Aurora" glassmorphism dark theme |

---

## 🔒 Security

- Passwords hashed with bcrypt (12 rounds)
- JWT: 15 min access + 7 day refresh tokens
- One-time email/reset tokens are stored as SHA-256 hashes and expire
- Production startup requires JWT secrets, HTTPS `APP_URL`, and SMTP configuration
- Production startup requires PostgreSQL, Redis, and private S3-compatible object storage; demo defaults are not allowed in production
- AI Analyst API keys stay server-side; raw dataset rows are not sent to the configured model provider
- Account lockout after 5 failed attempts
- File magic-bytes validation (not just extension)
- Rate limiting on auth endpoints
- Helmet.js security headers

---

## 📦 Analysis Deliverables

1. `cleaned_data.csv` — ETL-processed dataset
2. `eda_report.md` — Full statistical report in Markdown
3. `insights_report.md` — Business insights + recommendations
4. `visualizations/` — 10-15+ PNG charts (dark theme)
5. `analysis_notebook.ipynb` — Reproducible Jupyter notebook

EDA + ML and Full Pipeline analyses also generate `ml_report.md` when a usable target column is selected.

---

## 🎨 Design: "Soft Aurora" Theme

- Background: `#05060F` (deep space)
- Primary: `#8B7CF8` (soft lavender)
- Secondary: `#5ECFB2` (soft mint)
- Accent: `#F5A8C8` (soft rose)
- Animated aurora orbs: slow 9s pulse

---

## 🧪 Local SaaS Demo

```bash
copy .env.example .env
docker compose up --build -d
docker compose ps
docker compose logs -f app analysis-worker
```

This demo starts PostgreSQL, Redis/BullMQ, RustFS private S3-compatible object storage, Mailpit SMTP preview, the API/UI, and a separate Python analysis worker. Demo login is `demo@dsagent.ai` / `Demo@12345`. The billing screen activates a clearly marked fake subscription; it does not charge a card. You can create workspaces, invite a verified email, and inspect Mailpit previews. Use these services only on your own machine—demo credentials are intentionally public and insecure.

Useful demo controls:

```bash
docker compose logs -f app analysis-worker
docker compose down
```

Compose data volumes persist database/queue/files between runs. `docker compose down -v` **permanently deletes demo data**. The app/workers can be replicated after setting suitable worker concurrency and resource limits; do not expose the demo stack publicly.

To copy existing local SQLite accounts, analyses and files into PostgreSQL/RustFS before switching:

1. Stop the old API so it cannot change the SQLite database during the copy. Back up `ds_agent.db`, `uploads/`, and `outputs/`.
2. Start only the demo data services: `docker compose up -d postgres redis rustfs`.
3. In `ds-agent/.env`, temporarily set the **host-accessible** destination `DATABASE_URL=postgres://dsagent:dsagent-demo-only@localhost:5432/dsagent_demo`, `DATABASE_SSL=false`, `REDIS_URL=redis://localhost:6379`, `OBJECT_STORAGE_ENDPOINT=http://localhost:9000`, `OBJECT_STORAGE_BUCKET=ds-agent`, `OBJECT_STORAGE_ACCESS_KEY=dsagent-demo`, `OBJECT_STORAGE_SECRET_KEY=dsagent-demo-only`, `OBJECT_STORAGE_REGION=us-east-1`, and the `MIGRATION_SQLITE_PATH`, `MIGRATION_UPLOADS_DIR`, `MIGRATION_OUTPUTS_DIR` paths if your source locations differ from defaults.
4. Run `npm run migrate:sqlite`. This is a copy, not a destructive move. It intentionally clears refresh/reset/verification tokens; users sign in again. Stop and resolve any reported missing files or conflicting email before retrying.
5. Remove the temporary host `DATABASE_URL`/object-storage overrides if they were added. Compose sets its own internal service URLs. Then start the app: `docker compose up --build -d`.

The migration command requires Docker demo PostgreSQL, Redis and RustFS to be running and reachable on the host. For production, use the actual private storage and managed PostgreSQL connection strings from your hosting provider—not these demo values.

## 💳 Plans and Razorpay

Initial India-market recommendation; prices are per workspace seat/month and quotas are per seat:

| Plan | Price | Analysis quota |
|---|---:|---:|
| Free | ₹0 | 10 / month |
| Pro | ₹999 / seat / month | 100 / seat / month |
| Business | ₹2,499 / seat / month | 500 / seat / month |

All plans currently share the existing 100 MB per-file limit. Workspace membership, roles, invitation and seat limits are implemented. The local demo updates fake seat counts and never contacts Razorpay. Prices are an initial India-focused recommendation, not validated unit economics; review compute, storage, tax and payment costs before launch.

For real Razorpay **Test Mode** (not the demo):

1. In `ds-agent/.env`, set `DEMO_MODE=false`, production-like strong `JWT_SECRET` and `JWT_REFRESH_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and a separate `RAZORPAY_WEBHOOK_SECRET`.
2. Set `RAZORPAY_PLAN_PRO_MONTHLY_ID` and `RAZORPAY_PLAN_BUSINESS_MONTHLY_ID` after running `npm run billing:provision` once with Test Mode API credentials.
3. Configure the Razorpay dashboard webhook URL `https://<your-test-domain>/api/billing/webhook` with the same webhook secret. Keep live keys disabled.
4. Test subscription create/activation, webhook retries, cancellation and seat changes. A payment activation is trusted only after the signed Razorpay webhook.

`.env` is local-only; use your hosting provider's secret manager in deployment. Never paste secrets into chat or commit them.

## 🚀 Production configuration files

The local demo is not a production deployment. In the hosting provider's secret manager (not this committed template), configure:

| Variable / file | Set it to |
|---|---|
| `DATABASE_URL`, `DATABASE_SSL` | Managed PostgreSQL connection; SSL enabled per provider |
| `REDIS_URL` | Managed Redis with persistence/availability suitable for queued work |
| `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_ACCESS_KEY`, `OBJECT_STORAGE_SECRET_KEY`, `OBJECT_STORAGE_REGION` | Private S3-compatible bucket credentials; enable provider encryption and lifecycle/backup policies |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Two distinct random secrets of at least 32 characters |
| `DEMO_MODE` | `false` |
| `APP_URL`, `CORS_ORIGINS` | Your HTTPS app domain and exact allowed origins |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` | Real email provider, verified sender/domain and TLS requirements |
| `RAZORPAY_*` | Razorpay live credentials and production plan IDs, only after Test Mode passes |

`compose.yaml` is a local demo stack, not a cloud deployment manifest. `Dockerfile` builds the API/UI and Python worker runtime. Production must run `node backend/server.js` and `node backend/workers/analysis.js` as separately managed services, use HTTPS termination, backups, logs/alerts and provider-managed secrets. The API fails fast in production if PostgreSQL, Redis, object storage, email, HTTPS URL or non-demo mode is missing.

Before public launch, have the appropriate business/legal reviewer finalize Terms, Privacy Policy, refunds, invoices/GST and India DPDP notices/retention. Those obligations depend on the business and are not certified by this code.

---

Built with ❤️ using React + Express + PostgreSQL + Redis + S3-compatible storage + Python
✦ DS Agent — Autonomous Data Science Platform
