/**
 * GATE Mentor Agent
 * Implements an agentic loop using Claude's tool_use.
 * The agent can call multiple tools in sequence before responding.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { query, queryOne } = require('../db');
const { TOOL_DEFINITIONS, executeTool } = require('../tools/gate_tools');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are GATE Mentor — an intelligent AI study coach for GATE 2027 CSE preparation.

You have access to the student's real data through tools: their study sessions, error logs, PYQ progress, test scores, and study streaks. Always USE the tools to get current data before answering — don't guess or make up numbers.

Your personality:
- Direct and data-driven. Cite actual numbers from the tools.
- Encouraging but honest. Call out real weaknesses without sugar-coating.
- Proactive. When you see a pattern (e.g. no sessions in 3 days, DBMS repeatedly failing), point it out.
- Concise. Give actionable advice, not long lectures.

Core strategies you follow (based on AIR 35 + AIR 264 real toppers):
1. No-zero-day rule: minimum 4 hours daily, even on bad days
2. Subject cycle: lecture → short notes → topic test → full test → next subject  
3. 150+ mocks with 5–6 hrs of analysis each (analysis > quantity)
4. 3 PYQ rounds: during subject, after syllabus, 1 month before exam
5. Error log review: check it daily, not just when adding to it
6. 45 days before exam: feature phone, library mode

When generating study plans, be specific with time slots.
When analyzing mocks, identify the 1–2 subjects to fix immediately.
When the user seems demotivated, reference Karan Suthar's journey (AIR 12,000 → AIR 35).

Today's date: ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.
GATE 2027 is approximately in February 2027. Track urgency accordingly.`;

// ── Agentic loop ──────────────────────────────────────────────────────────────
async function runAgent(userId, userMessage, conversationHistory = []) {
  // Load last 10 messages from DB for context
  const dbHistory = await query(
    'SELECT role, content FROM agent_messages WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10',
    [userId]
  );
  const history = [
    ...dbHistory.reverse(),
    { role: 'user', content: userMessage }
  ];

  // Save user message
  await query(
    'INSERT INTO agent_messages (user_id, role, content) VALUES ($1, $2, $3)',
    [userId, 'user', userMessage]
  );

  const messages = history.map(m => ({ role: m.role, content: m.content }));
  let finalResponse = '';
  let toolsUsed = [];
  let iterations = 0;
  const MAX_ITERATIONS = 6; // prevent infinite loops

  // ── Agentic loop: keep calling Claude until no more tool_use ──
  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS,
      messages
    });

    // Collect any text from this turn
    const textBlocks = response.content.filter(b => b.type === 'text');
    if (textBlocks.length > 0) {
      finalResponse = textBlocks.map(b => b.text).join('\n');
    }

    // Check if agent wants to use tools
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      break; // Agent is done
    }

    // Execute all tool calls in parallel
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (toolCall) => {
        toolsUsed.push(toolCall.name);
        const result = await executeTool(toolCall.name, toolCall.input, userId);
        return {
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: JSON.stringify(result)
        };
      })
    );

    // Add assistant message + tool results to history for next iteration
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }

  // Save assistant response to DB
  if (finalResponse) {
    await query(
      'INSERT INTO agent_messages (user_id, role, content) VALUES ($1, $2, $3)',
      [userId, 'assistant', finalResponse]
    );
  }

  return { response: finalResponse, tools_used: toolsUsed, iterations };
}

// ── Proactive daily briefing (called on page load) ────────────────────────────
async function getDailyBriefing(userId) {
  const todayKey = new Date().toISOString().split('T')[0];
  const cacheKey = `briefing_${todayKey}`;

  // Check if we already gave a briefing today
  const cached = await queryOne(
    `SELECT content FROM agent_messages WHERE user_id=$1 AND role='assistant'
     AND created_at >= NOW() - INTERVAL '12 hours'
     AND content LIKE '%📊%'
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (cached) return { response: cached.content, cached: true };

  // Generate fresh briefing
  const prompt = `Give me today's morning briefing. 
  Use get_study_stats, get_subject_breakdown, get_recent_sessions (last 3 days), and get_today_plan tools.
  Format it as:
  📊 **Today's Snapshot** — [date]
  Brief 2-line summary of where I stand.
  
  ⚠️ **Action Required** — 1-2 specific things to fix today based on data.
  
  🎯 **Today's Focus** — what to study today and why.
  
  Keep it under 200 words. Be direct.`;

  return runAgent(userId, prompt);
}

module.exports = { runAgent, getDailyBriefing };
