'use strict';

/**
 * Deep qualitative analysis for stocks that have ALREADY cleared the
 * 13-parameter quantitative screen (see scan_multibagger.js) — this is
 * deliberately not run on the full daily batch, only on new qualifying
 * candidates, since it's a real per-call API cost and only a handful of
 * stocks clear the quantitative bar on any given day.
 *
 * Was Claude Opus, then Haiku (2026-08-30 repo-wide cost cut) -- switched to
 * Gemini 2026-08-31, matching every other former-Anthropic call in this repo
 * (NewsPoller, PromptRatingService, MarketBulletinService, trading-agents-
 * service). Confirmed live via trading-agents-service that gemini-3.1-flash-
 * lite runs roughly 20-40x cheaper than Haiku was for equivalent tasks. Note
 * this is still a real quality tradeoff vs. the original Opus choice for this
 * specific multi-section write-up (see the 2026-08-30 note this superseded);
 * low volume (a handful of stocks/day) means cost alone was never the
 * deciding factor here.
 *
 * Raw REST call (Gemini's generateContent, non-streaming) rather than a new
 * SDK dependency -- this repo has no existing @google/genai usage to build
 * on, and a single non-streaming request is simpler than replicating the
 * Anthropic SDK's streaming pattern for a REST API with a 131K output-token
 * ceiling (comfortably above this prompt's ~12K-token needs either way).
 */

const MODEL = 'gemini-3.1-flash-lite';
const MAX_OUTPUT_TOKENS = 12000;

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
  const prompt = buildPrompt(companyName, ticker, capitalRupees);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    }),
  });
  if (!res.ok) {
    throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini response had no text content');
  return text.trim();
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
