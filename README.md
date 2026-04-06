# GATE 2027 — AI Mentor Agent
### CSE · Agentic AI · Render (free) + Vercel (free)

An AI-powered GATE preparation agent that autonomously calls tools, reads your real study data, and gives proactive coaching — not just answers.

---

## What makes this an AI Agent (not just a chatbot)

| Feature | How it works |
|---------|-------------|
| Tool use | Claude calls 10 real tools (get_study_stats, generate_daily_plan, analyze_mock_test...) |
| Agentic loop | Runs multiple tool calls in sequence before responding |
| Memory | Stores conversation history + key insights in PostgreSQL |
| Proactive | Morning briefing auto-generated on page load |
| Data-grounded | All advice is based on YOUR actual sessions, errors, PYQ status |

---

## Project structure

```
gate-agent/
├── backend/
│   ├── agents/
│   │   └── mentor_agent.js    ← Agentic loop (Claude + tools)
│   ├── tools/
│   │   └── gate_tools.js      ← 10 tools the agent can call
│   ├── db.js                  ← PostgreSQL + pgvector setup
│   ├── server.js              ← Express API
│   ├── render.yaml            ← Render deployment config
│   └── .env.example
├── frontend/
│   ├── index.html             ← Full UI (chat + dashboard + tracker)
│   └── vercel.json
└── .gitignore
```

---

## Deploy: Render (backend) + Vercel (frontend)

### Step 1 — Push to GitHub (NO secrets in code)
```powershell
# Fresh clean repo
Remove-Item .git -Recurse -Force
git init && git branch -M main
git add . && git commit -m "GATE AI Agent"
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push --force origin main
```

### Step 2 — Render (backend + database)
1. render.com → New → PostgreSQL → Free → name: gate-agent-db
2. render.com → New → Web Service → connect repo
   - Root directory: backend
   - Build: npm install
   - Start: npm start
3. Environment variables on Render:
   ```
   DATABASE_URL         (auto-injected from step 1)
   CLERK_PUBLISHABLE_KEY    pk_test_...
   CLERK_SECRET_KEY         sk_test_...
   ANTHROPIC_API_KEY        sk-ant-...
   FRONTEND_URL             https://your-app.vercel.app
   NODE_ENV                 production
   ```

### Step 3 — Vercel (frontend)
1. vercel.com → New Project → root dir: frontend → Framework: Other
2. Build command (in Vercel settings):
   ```
   sed -i "s|window.__BACKEND_URL__ || ''|'https://YOUR-RENDER-URL.onrender.com'|g" index.html
   ```
3. Output directory: .

### Step 4 — Clerk
1. dashboard.clerk.com → New app → Email + Password
2. Copy pk_test_... and sk_test_... → paste into Render env vars
3. Add your Vercel URL to Clerk allowed origins

---

## Agent tools available

| Tool | What it does |
|------|-------------|
| get_study_stats | Overall hours, score, streak, error count |
| get_subject_breakdown | Hours + avg score per subject |
| get_recent_errors | Error log with type summary |
| get_pyq_status | PYQ matrix — which rounds are incomplete |
| get_recent_sessions | Session history for last N days |
| generate_daily_plan | Creates + saves a time-slotted study plan |
| get_today_plan | Retrieves today's saved plan |
| analyze_mock_test | Scores, weak subjects, time analysis |
| save_memory | Saves insight to long-term memory |
| recall_memories | Searches memory for relevant context |

---

## Local development
```bash
cd backend
cp .env.example .env
# Fill .env — use a local Postgres or Neon (neon.tech, free)
npm install
npm run dev
# → http://localhost:3001
```
Open frontend/index.html directly in browser for local UI.

---

## Strategy the agent follows
- No-zero-day rule (Karan Suthar, AIR 35): 4h minimum daily
- Subject cycle: lecture → notes → topic test → full test → repeat
- 150+ mocks, 5–6 hrs analysis each (Karan Suthar method)
- 3 PYQ rounds per subject (AIR 264 method)
- 45 days before: feature phone, library mode
