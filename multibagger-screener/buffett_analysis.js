'use strict';

/**
 * Deep qualitative analysis for stocks that have ALREADY cleared the
 * 13-parameter quantitative screen (see scan_multibagger.js) — this is
 * deliberately not run on the full daily batch, only on new qualifying
 * candidates, since it's a real per-call API cost and only a handful of
 * stocks clear the quantitative bar on any given day.
 *
 * Uses Claude Opus with adaptive thinking (this is a genuinely complex,
 * judgment-heavy analytical task, not a simple extraction) via the
 * official Anthropic SDK, streamed (the response can run long across 8
 * sections) and resolved via .finalMessage().
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 12000;

const PROMPT_TEMPLATE = `Analyze {{COMPANY}} (NSE: {{TICKER}}) as Warren Buffett would evaluate a potential 100-bagger for a 20-30 year holding period. My capital: ₹{{CAPITAL}}.

Work through this framework:

1. CIRCLE OF COMPETENCE
Explain the business in one paragraph a 10-year-old could understand. If the business model is too complex or the industry too unpredictable, say "too hard pile" and stop.

2. ECONOMIC MOAT (most important section)
- What is the durable competitive advantage: brand, switching costs, network effects, cost advantage, or regulatory license?
- Is the moat widening or narrowing? Give evidence from the last 10 years.
- Could a well-funded competitor destroy this business in 10 years? How?

3. FINANCIAL QUALITY (10-year view, not last quarter)
- ROE and ROCE consistency (Buffett wants >15% sustained without leverage)
- Revenue and profit CAGR over 10 years
- Free cash flow conversion — does accounting profit become real cash?
- Debt-to-equity (prefer near zero)
- Reinvestment runway: can they redeploy earnings at high returns, or do they run out of opportunities?

4. MANAGEMENT
- Capital allocation track record: dividends, buybacks, acquisitions — value-creating or ego-driven?
- Promoter integrity, skin in the game, related-party red flags
- Would I trust them with my money for 20 years unmonitored?

5. RUNWAY & OPTIONALITY (the multibagger test)
- How large can this business realistically be in 20 years vs. today?
- Is the addressable market growing structurally (like IT services was in 1992)?
- What is today's equivalent of "Infosys in 1992" about this company?

6. VALUATION & MARGIN OF SAFETY
- Estimate intrinsic value using owner earnings, not just P/E
- What price makes this a "wonderful company at a fair price"?
- What am I paying today for growth that may not materialize?

7. PRE-MORTEM
Assume it's 2046 and this investment failed. Write the 3 most likely reasons why.

8. VERDICT
Buy / Watch / Avoid — with the single strongest reason for and against. Then state: if I could only make 20 investments in my lifetime (Buffett's punch card), does this deserve a slot?`;

function buildPrompt(companyName, ticker, capitalRupees) {
  return PROMPT_TEMPLATE.replace('{{COMPANY}}', companyName)
    .replace('{{TICKER}}', ticker)
    .replace('{{CAPITAL}}', capitalRupees.toLocaleString('en-IN'));
}

/** Returns the analysis as plain text, or throws (caller should catch and treat as "skip, don't block the alert"). */
async function generateBuffettAnalysis(companyName, ticker, capitalRupees, apiKey) {
  const client = new Anthropic({ apiKey });
  const prompt = buildPrompt(companyName, ticker, capitalRupees);
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  });
  const message = await stream.finalMessage();
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Splits long text into Telegram-safe chunks (<4096 chars), breaking on paragraph boundaries where possible. */
function chunkForTelegram(text, maxLen = 3900) {
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let cur = '';
  for (const p of paragraphs) {
    const candidate = cur ? `${cur}\n\n${p}` : p;
    if (candidate.length > maxLen) {
      if (cur) chunks.push(cur);
      if (p.length > maxLen) {
        // Single paragraph longer than the limit — hard-split it.
        for (let i = 0; i < p.length; i += maxLen) chunks.push(p.slice(i, i + maxLen));
        cur = '';
      } else {
        cur = p;
      }
    } else {
      cur = candidate;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

module.exports = { generateBuffettAnalysis, buildPrompt, chunkForTelegram, PROMPT_TEMPLATE };
