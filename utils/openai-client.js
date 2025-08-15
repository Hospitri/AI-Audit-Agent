const OpenAI = require('openai');
require('dotenv').config();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = [
    'You are Hospitri’s Listing Auditor.',
    'Input: reduced text extracted from a single OTA listing (Airbnb / Booking / VRBO).',
    'Output: ONE valid JSON object, no prose, no extra keys.',
    '',
    'Scoring bar:',
    '- Be strict and realistic: 7 = average, 8 = good, 9–10 = exceptional (rare).',
    '- Penalize missing/incomplete/generic content.',
    '',
    'Weights for overall_score (sum 100):',
    'images 18, description 15, title 12, amenities 12, reviews 12, pricing 12, policies_fees 10, response_speed 9.',
    'Return overall_score as 0.0–10.0 (1 decimal). Do NOT return percentages.',
    '',
    'Style for short texts: 2nd person, concise, energetic. No internal calcs.',
    '',
    'Quick wins (exactly 3): action(≤60), effort Low|Med|High, potential_uplift_type revenue|experience,',
    'potential_uplift: $, $$, $$$ (revenue) or ⚡, ⚡⚡, ⚡⚡⚡ (experience). Order by highest impact.',
    '',
    'If you can infer a title, set listing_title.',
].join('\n');

function clampNicely(str, max = 60) {
    if (!str || typeof str !== 'string') return '';
    if (str.length <= max) return str.trim();
    const s = str.slice(0, max);
    const cut = s.lastIndexOf(' ');
    const out = (cut > 20 ? s.slice(0, cut) : s)
        .replace(/\b(the|a|an|and|or|to|of|in|with)$/i, '')
        .trim();
    return out;
}

function normalizeAudit(audit) {
    if (!audit || typeof audit !== 'object') return audit;

    const weights = {
        images: 18,
        description: 15,
        title: 12,
        amenities: 12,
        reviews: 12,
        pricing: 12,
        policies_fees: 10,
        response_speed: 9,
    };

    const cb = audit.category_breakdown || {};
    for (const key of Object.keys(weights)) {
        if (!cb[key]) continue;
        const c = cb[key];
        c.numeric = Math.max(0, Math.min(10, parseInt(c.numeric ?? 0, 10)));
        c.grade = ['A', 'B', 'C', 'D'].includes(c.grade) ? c.grade : 'C';
        c.what_works = clampNicely(c.what_works, 60);
        c.what_to_improve = clampNicely(c.what_to_improve, 60);
    }

    let total = 0;
    for (const [k, w] of Object.entries(weights))
        total += (cb[k]?.numeric || 0) * w;
    audit.overall_score = Math.round((total / 100) * 10) / 10;

    return audit;
}

const MAX_TOKENS = parseInt(process.env.OPENAI_MAX_TOKENS || '1500', 10);

async function generateAudit({ html }) {
    if (!html || typeof html !== 'string') {
        throw new Error('generateAudit(html) expects a non-empty string');
    }

    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        {
            role: 'user',
            content: [
                'Return ONLY the JSON with this schema (no prose):',
                `{
                    "overall_score": number (0..10, 1 decimal),
                    "category_breakdown": {
                        "title": {"numeric": int, "grade": "A|B|C|D", "what_works": string<=60, "what_to_improve": string<=60},
                        "description": {...},
                        "images": {...},
                        "amenities": {...},
                        "reviews": {...},
                        "pricing": {...},
                        "policies_fees": {...},
                        "response_speed": {...}
                    },
                    "quick_wins": [
                        {"action": string<=60, "effort": "Low|Med|High", "potential_uplift_type":"revenue|experience", "potential_uplift":"$|$$|$$$|⚡|⚡⚡|⚡⚡⚡"},
                        {...},
                        {...}
                    ],
                    "pro_tip": string<=400,
                    "listing_title": string
                    }`,
                'Here is the reduced listing text:',
                html,
            ].join('\n'),
        },
    ];

    const resp = await client.chat.completions.create({
        model,
        messages,
        response_format: { type: 'json_object' },
        max_tokens: MAX_TOKENS,
    });

    if (resp.usage) {
        console.log('[OpenAI usage]', {
            model: resp.model,
            prompt_tokens: resp.usage.prompt_tokens,
            completion_tokens: resp.usage.completion_tokens,
            total_tokens: resp.usage.total_tokens,
        });
    }

    const jsonText = resp.choices?.[0]?.message?.content;
    if (!jsonText || !jsonText.trim())
        throw new Error('OpenAI response was empty');

    let audit;
    try {
        audit = JSON.parse(jsonText);
    } catch (err) {
        console.error('Error parsing JSON from model:', jsonText);
        throw err;
    }

    return normalizeAudit(audit);
}

module.exports = { generateAudit };
