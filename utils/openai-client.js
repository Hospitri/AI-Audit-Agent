const OpenAI = require('openai');
require('dotenv').config();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function generateAudit({ scraped }) {
    const prompt = `You are “Hospitri AI Listing Auditor.”
    Goal: turn one public OTA listing (Airbnb / Booking / VRBO) into a clear JSON audit.
    General rules
    • Output **one valid JSON object and nothing else**.
    • Use concise, energetic language (2nd-person, action-oriented).
    • Never reveal internal calculations or weighting.
    • If a field is missing in the input JSON, treat it as null and grade accordingly.
    
    Scoring model
    • Provide **numeric scores 0-10** (integers) and a **letter grade** (A=excellent ≥9, B=good 8-8.9, C=fair 7-7.9, D=needs work <7).
    • Weight categories for the overall score:
      images 18 %, description 15 %, title 12 %, amenities_consistency 12 %,
      review_sentiment 12 %, pricing 12 %, policies_fees 10 %, response_speed 9 %.
    • Round overall_score to one decimal place.

    Categories (in this order):
    1. title
    2. description
    3. images
    4. amenities_consistency
    5. review_sentiment
    6. pricing
    7. policies_fees
    8. response_speed

    For **each category** return:
      - numeric  (int 0-10)
      - grade    (string A-D)
      - what_works        (≤40 chars)
      - what_to_improve   (≤40 chars)

    Quick-wins:
    • Generate exactly **three** quick wins.
    • Each has: action (≤60 chars), effort (Low | Med | High), potential_uplift (“$” for revenue or “⚡” for guest experience).
    • Order by highest impact.

    Pro tip:
    • One upbeat paragraph ≤60 words.

    Output schema:
    {
      "overall_score": 8.4,
      "category_breakdown": {
        "title": { "numeric":8, "grade":"B", "what_works":"…", "what_to_improve":"…" },
        …
      },
      "quick_wins":[
        {"action":"…","effort":"Low","potential_uplift":"$"},
        …
      ],
      "pro_tip":"…"
    }
    Here is the scraped listing data.  Produce the audit JSON per instructions above.
    ${JSON.stringify(scraped)}
}`;

    const resp = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
    });

    const text = resp.choices[0].message.content;

    try {
        const json = JSON.parse(text);
        return json;
    } catch (e) {
        // fallback: ask again or wrap in a best-effort parser
        throw new Error('OpenAI response not valid JSON: ' + e.message);
    }
}

module.exports = { generateAudit };
