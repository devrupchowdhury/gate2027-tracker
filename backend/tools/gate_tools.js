/**
 * GATE Agent Tools
 * These are the "skills" the AI agent can invoke via tool_use.
 * Each tool maps to a real DB query or computation.
 */

const { query, queryOne } = require('../db');

// ── Tool definitions (sent to Claude as tool specs) ──────────────────────────
const TOOL_DEFINITIONS = [
  {
    name: 'get_study_stats',
    description: 'Get overall study statistics for the user: total hours, average test score, subjects covered, error counts, and streak.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_subject_breakdown',
    description: 'Get hours studied and average score per subject. Use this to identify weak or neglected subjects.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_recent_errors',
    description: 'Get the most recent error log entries. Use this to identify recurring mistake patterns.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of errors to fetch (default 10)' },
        subject: { type: 'string', description: 'Filter by subject (optional)' }
      },
      required: []
    }
  },
  {
    name: 'get_pyq_status',
    description: 'Get PYQ completion status across all subjects and rounds. Use to find which PYQ rounds are incomplete.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_recent_sessions',
    description: 'Get recent study sessions to understand the user\'s current momentum and schedule.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of past days to fetch (default 7)' }
      },
      required: []
    }
  },
  {
    name: 'generate_daily_plan',
    description: 'Generate and save a structured daily study plan for today based on the user\'s weak subjects, pending PYQs, and study history.',
    input_schema: {
      type: 'object',
      properties: {
        focus_subjects: {
          type: 'array',
          items: { type: 'string' },
          description: 'Subjects to prioritize today'
        },
        available_hours: {
          type: 'number',
          description: 'How many hours the user has available today'
        },
        plan_type: {
          type: 'string',
          enum: ['subject_study', 'revision', 'mock_prep', 'pyq_practice', 'mixed'],
          description: 'Type of study session to plan'
        }
      },
      required: ['focus_subjects', 'available_hours', 'plan_type']
    }
  },
  {
    name: 'analyze_mock_test',
    description: 'Analyze a mock test result the user has pasted. Returns a detailed breakdown of performance by subject and actionable improvements.',
    input_schema: {
      type: 'object',
      properties: {
        score: { type: 'number', description: 'Total score out of 100' },
        subject_scores: {
          type: 'object',
          description: 'Score per subject, e.g. {"OS": 80, "DBMS": 45, "CN": 60}'
        },
        time_taken_mins: { type: 'number', description: 'Time taken in minutes' },
        attempted: { type: 'number', description: 'Number of questions attempted' },
        total_questions: { type: 'number', description: 'Total questions in mock' }
      },
      required: ['score']
    }
  },
  {
    name: 'get_today_plan',
    description: 'Retrieve today\'s study plan if one has been generated.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'save_memory',
    description: 'Save an important insight, goal, or fact about the user to long-term memory for future reference.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The insight or fact to remember' },
        type: {
          type: 'string',
          enum: ['goal', 'insight', 'weakness', 'strength', 'preference'],
          description: 'Type of memory'
        }
      },
      required: ['content', 'type']
    }
  },
  {
    name: 'recall_memories',
    description: 'Recall relevant memories about the user based on a topic or query.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for in memory' },
        limit: { type: 'number', description: 'Max memories to return (default 5)' }
      },
      required: ['query']
    }
  }
];

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(toolName, toolInput, userId) {
  switch (toolName) {

    case 'get_study_stats': {
      const [hours, score, tests, errors, subjects, streak] = await Promise.all([
        queryOne('SELECT COALESCE(SUM(hours),0)::numeric(10,1) as v FROM sessions WHERE user_id=$1', [userId]),
        queryOne('SELECT ROUND(AVG(score)::numeric,1) as v FROM sessions WHERE user_id=$1 AND score IS NOT NULL', [userId]),
        queryOne('SELECT COUNT(*) as v FROM sessions WHERE user_id=$1 AND score IS NOT NULL', [userId]),
        queryOne('SELECT COUNT(*) as v FROM errors WHERE user_id=$1', [userId]),
        queryOne('SELECT COUNT(DISTINCT subject) as v FROM sessions WHERE user_id=$1', [userId]),
        query(`SELECT DISTINCT date FROM sessions WHERE user_id=$1 AND date >= (CURRENT_DATE - INTERVAL '30 days')::text ORDER BY date DESC`, [userId])
      ]);
      let streakCount = 0;
      const today = new Date();
      const dateSet = new Set(streak.map(r => r.date));
      for (let i = 0; i <= 30; i++) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        const ds = d.toISOString().split('T')[0];
        if (dateSet.has(ds)) streakCount++;
        else if (i > 0) break;
      }
      return {
        total_hours: parseFloat(hours?.v || 0),
        avg_score: score?.v ? parseFloat(score.v) : null,
        tests_taken: parseInt(tests?.v || 0),
        errors_logged: parseInt(errors?.v || 0),
        subjects_active: parseInt(subjects?.v || 0),
        current_streak_days: streakCount
      };
    }

    case 'get_subject_breakdown': {
      const rows = await query(`
        SELECT subject,
               ROUND(SUM(hours)::numeric,1) as total_hours,
               ROUND(AVG(score)::numeric,1) as avg_score,
               COUNT(*) as sessions
        FROM sessions WHERE user_id=$1
        GROUP BY subject ORDER BY total_hours DESC
      `, [userId]);
      return { subjects: rows };
    }

    case 'get_recent_errors': {
      const limit = toolInput.limit || 10;
      const params = toolInput.subject
        ? [userId, toolInput.subject, limit]
        : [userId, limit];
      const rows = toolInput.subject
        ? await query('SELECT * FROM errors WHERE user_id=$1 AND subject=$2 ORDER BY created_at DESC LIMIT $3', params)
        : await query('SELECT * FROM errors WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', params);
      const typeCounts = rows.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {});
      return { errors: rows, type_summary: typeCounts, total: rows.length };
    }

    case 'get_pyq_status': {
      const done = await query('SELECT * FROM pyqs WHERE user_id=$1', [userId]);
      const subjects = ['Engineering Mathematics','Data Structures & Algorithms','Algorithms','Theory of Computation','Compiler Design','Operating Systems','DBMS','Computer Networks','Computer Organisation & Architecture','Digital Logic'];
      const rounds = ['Round 1 — during subject','Round 2 — after syllabus','Round 3 — month before'];
      const matrix = subjects.map(s => ({
        subject: s,
        rounds: rounds.map(r => {
          const p = done.find(x => x.subject === s && x.round === r);
          return { round: r, done: !!p, accuracy: p?.accuracy || null };
        }),
        completion_pct: Math.round((rounds.filter(r => done.find(x => x.subject === s && x.round === r)).length / 3) * 100)
      }));
      const incomplete = matrix.filter(s => s.completion_pct < 100);
      return { matrix, incomplete_subjects: incomplete, total_done: done.length, total_possible: subjects.length * 3 };
    }

    case 'get_recent_sessions': {
      const days = toolInput.days || 7;
      const rows = await query(`
        SELECT * FROM sessions WHERE user_id=$1
        AND date >= (CURRENT_DATE - INTERVAL '${days} days')::text
        ORDER BY date DESC
      `, [userId]);
      const totalHours = rows.reduce((s, r) => s + r.hours, 0);
      return { sessions: rows, total_hours_period: Math.round(totalHours * 10) / 10, days_covered: days };
    }

    case 'generate_daily_plan': {
      const { focus_subjects, available_hours, plan_type } = toolInput;
      const today = new Date().toISOString().split('T')[0];
      const timeSlots = buildTimeSlots(focus_subjects, available_hours, plan_type);
      const plan = {
        date: today,
        plan_type,
        available_hours,
        focus_subjects,
        time_slots: timeSlots,
        generated_at: new Date().toISOString()
      };
      await query(`
        INSERT INTO study_plans (user_id, date, plan)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, date) DO UPDATE SET plan=$3, generated_at=NOW()
      `, [userId, today, JSON.stringify(plan)]);
      return { success: true, plan };
    }

    case 'get_today_plan': {
      const today = new Date().toISOString().split('T')[0];
      const row = await queryOne('SELECT * FROM study_plans WHERE user_id=$1 AND date=$2', [userId, today]);
      return row ? { exists: true, plan: row.plan } : { exists: false, message: 'No plan for today yet. Ask me to generate one!' };
    }

    case 'analyze_mock_test': {
      const { score, subject_scores = {}, time_taken_mins, attempted, total_questions } = toolInput;
      const weakSubjects = Object.entries(subject_scores).filter(([,s]) => s < 60).sort((a,b) => a[1]-b[1]);
      const strongSubjects = Object.entries(subject_scores).filter(([,s]) => s >= 75).sort((a,b) => b[1]-a[1]);
      const accuracy = attempted && total_questions ? Math.round((attempted / total_questions) * 100) : null;
      const avgTimePerQ = time_taken_mins && attempted ? Math.round((time_taken_mins / attempted) * 10) / 10 : null;
      return {
        overall_score: score,
        grade: score >= 80 ? 'Excellent' : score >= 65 ? 'Good' : score >= 50 ? 'Average' : 'Needs work',
        weak_subjects: weakSubjects.map(([s, sc]) => ({ subject: s, score: sc })),
        strong_subjects: strongSubjects.map(([s, sc]) => ({ subject: s, score: sc })),
        accuracy_pct: accuracy,
        avg_time_per_question_mins: avgTimePerQ,
        time_pressure: avgTimePerQ > 2.5 ? 'high' : avgTimePerQ < 1.5 ? 'low' : 'normal',
        priority_action: weakSubjects.length > 0 ? `Focus on ${weakSubjects[0][0]} (${weakSubjects[0][1]}%) immediately` : 'Maintain current performance'
      };
    }

    case 'save_memory': {
      await query(
        'INSERT INTO memory_chunks (user_id, type, content, metadata) VALUES ($1, $2, $3, $4)',
        [userId, toolInput.type, toolInput.content, JSON.stringify({ source: 'agent' })]
      );
      return { saved: true, content: toolInput.content };
    }

    case 'recall_memories': {
      const limit = toolInput.limit || 5;
      // Simple text search (upgrade to vector search when embedding endpoint available)
      const rows = await query(`
        SELECT type, content, created_at FROM memory_chunks
        WHERE user_id=$1
        AND content ILIKE $2
        ORDER BY created_at DESC LIMIT $3
      `, [userId, `%${toolInput.query}%`, limit]);
      return { memories: rows, found: rows.length };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// Helper: build time slots for a daily plan
function buildTimeSlots(subjects, hours, planType) {
  const slots = [];
  const slotDuration = hours <= 4 ? 1 : 1.5;
  let cursor = 9; // start at 9 AM

  subjects.forEach((subject, i) => {
    if (i * slotDuration >= hours) return;
    slots.push({
      time: `${cursor}:00 – ${cursor + slotDuration}:00`,
      subject,
      activity: planType === 'pyq_practice' ? 'Solve PYQs (2015–2024)' :
                planType === 'revision' ? 'Revise notes + formula sheet' :
                planType === 'mock_prep' ? 'Timed topic test + analysis' :
                'Lecture/concept + make short notes',
      duration_hrs: slotDuration
    });
    cursor += slotDuration + 0.25; // 15 min break
  });

  // Add analysis/review slot at the end
  if (planType !== 'subject_study') {
    slots.push({
      time: `${cursor}:00 – ${cursor + 0.5}:00`,
      subject: 'Review',
      activity: 'Update error log + mark completed items',
      duration_hrs: 0.5
    });
  }

  return slots;
}

module.exports = { TOOL_DEFINITIONS, executeTool };
