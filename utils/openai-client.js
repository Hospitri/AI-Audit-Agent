const OpenAI = require('openai');
require('dotenv').config();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CATEGORY_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['numeric', 'grade', 'what_works', 'what_to_improve'],
    properties: {
        numeric: { type: 'integer', minimum: 0, maximum: 10 },
        grade: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
        what_works: { type: 'string', maxLength: 60 },
        what_to_improve: { type: 'string', maxLength: 60 },
    },
};

const AUDIT_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: [
        'listing_title',
        'overall_score',
        'category_breakdown',
        'quick_wins',
        'pro_tip',
    ],
    properties: {
        listing_title: { type: 'string' },
        overall_score: { type: 'number' },
        category_breakdown: {
            type: 'object',
            additionalProperties: false,
            required: [
                'title',
                'description',
                'images',
                'amenities',
                'reviews',
                'pricing',
                'policies_fees',
                'response_speed',
            ],
            properties: {
                title: CATEGORY_SCHEMA,
                description: CATEGORY_SCHEMA,
                images: CATEGORY_SCHEMA,
                amenities: CATEGORY_SCHEMA,
                reviews: CATEGORY_SCHEMA,
                pricing: CATEGORY_SCHEMA,
                policies_fees: CATEGORY_SCHEMA,
                response_speed: CATEGORY_SCHEMA,
            },
        },
        quick_wins: {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            items: {
                type: 'object',
                additionalProperties: false,
                required: [
                    'action',
                    'effort',
                    'potential_uplift_type',
                    'potential_uplift',
                ],
                properties: {
                    action: { type: 'string', maxLength: 60 },
                    effort: { type: 'string', enum: ['Low', 'Med', 'High'] },
                    potential_uplift_type: {
                        type: 'string',
                        enum: ['revenue', 'experience'],
                    },
                    potential_uplift: {
                        type: 'string',
                        enum: ['$', '$$', '$$$', '⚡', '⚡⚡', '⚡⚡⚡'],
                    },
                },
            },
        },
        pro_tip: { type: 'string', maxLength: 400 },
    },
};

const SYSTEM_PROMPT = [
    'You are Hospitri’s Listing Auditor.',
    'Input = extracted text from an OTA listing (Airbnb/Booking/VRBO).',
    'Output = ONE JSON matching the provided schema (no extra keys, no prose).',
    '',
    'Scoring bar:',
    '- Be strict and realistic: 7 = average, 8 = good, 9–10 = exceptional (rare).',
    '- Penalize missing/incomplete/generic content.',
    '',
    'Weights for overall_score (sum 100):',
    'images 18, description 15, title 12, amenities 12, reviews 12, pricing 12, policies_fees 10, response_speed 9.',
    'Return overall_score as a number in the range 0.0–10.0 (one decimal). Do not use percentages.',
    '',
    'Style for short texts:',
    '- 2nd person, concise, energetic.',
    '- No internal calcs; no weighting details.',
    '',
    'Quick wins:',
    '- Exactly 3 items; map Effort→impact symbols: Low→1, Med→2, High→3.',
    '- If potential_uplift_type = revenue, use $, $$, $$$.',
    '- If … = experience, use ⚡, ⚡⚡, ⚡⚡⚡.',
    '- Order by highest impact.',
    '',
    'If you can infer a listing title, set listing_title.',
].join('\n');

const MAX_INPUT_CHARS = 60000;

function buildInputMessages(html) {
    if (!html || typeof html !== 'string') {
        throw new Error('generateAudit() requires a non-empty HTML string');
    }
    const safeHtml =
        html.length > MAX_INPUT_CHARS ? html.slice(0, MAX_INPUT_CHARS) : html;

    return [
        {
            role: 'system',
            content: [{ type: 'input_text', text: SYSTEM_PROMPT }],
        },
        {
            role: 'user',
            content: [
                {
                    type: 'input_text',
                    text: 'Extracted listing text (reduced):',
                },
                { type: 'input_text', text: safeHtml },
            ],
        },
    ];
}

function getParsedJsonFromResponse(resp) {
    if (resp.output_parsed && typeof resp.output_parsed === 'object')
        return resp.output_parsed;

    const outputs = resp.output || resp.outputs || [];
    for (const o of outputs) {
        const parts = o.content || [];
        for (const p of parts) {
            if (p?.parsed && typeof p.parsed === 'object') return p.parsed;
            if (p?.type === 'json' && p.json && typeof p.json === 'object')
                return p.json;
        }
    }
    if (typeof resp.output_text === 'string' && resp.output_text.trim()) {
        return JSON.parse(resp.output_text);
    }
    for (const o of outputs) {
        const parts = o.content || [];
        for (const p of parts) {
            if (p?.type === 'output_text') {
                const t = typeof p.text === 'string' ? p.text : p.text?.value;
                if (t && t.trim()) return JSON.parse(t);
            }
            if (p?.type === 'text') {
                const t = typeof p.text === 'string' ? p.text : p.text?.value;
                if (t && t.trim()) return JSON.parse(t);
            }
        }
    }
    return null;
}

function smartClamp(str, max = 60) {
    if (!str || typeof str !== 'string') return '';
    if (str.length <= max) return str;
    const sliced = str.slice(0, max);
    const lastSpace = sliced.lastIndexOf(' ');
    let out = lastSpace > 20 ? sliced.slice(0, lastSpace) : sliced;
    out = out.replace(/\b(the|a|an|and|or|to|of|in|with)$/i, '').trim();
    return out;
}

function normalizeAudit(audit) {
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

    for (const key of Object.keys(weights)) {
        const c = audit?.category_breakdown?.[key];
        if (c) {
            c.what_works = smartClamp(c.what_works, 60);
            c.what_to_improve = smartClamp(c.what_to_improve, 60);
            c.numeric = Math.max(0, Math.min(10, parseInt(c.numeric ?? 0, 10)));
        }
    }

    let total = 0;
    for (const [k, w] of Object.entries(weights)) {
        total += (audit.category_breakdown?.[k]?.numeric || 0) * w;
    }
    const normalized = Math.round((total / 100) * 10) / 10;
    audit.overall_score = normalized;

    return audit;
}

async function generateAudit({
    html,
    model = process.env.OPENAI_MODEL || 'gpt-5-nano',
}) {
    const input = buildInputMessages(html);

    const resp = await client.responses.create({
        model,
        input,
        text: {
            format: {
                type: 'json_schema',
                name: 'hospitri_listing_audit',
                schema: AUDIT_JSON_SCHEMA,
                strict: true,
            },
        },
        max_output_tokens: 10000,
    });

    if (resp.usage) {
        console.log('[OpenAI usage]', {
            model: resp.model,
            input_tokens: resp.usage.input_tokens,
            output_tokens: resp.usage.output_tokens,
            total_tokens: resp.usage.total_tokens,
        });
    }

    let json = getParsedJsonFromResponse(resp);
    if (!json) {
        const shape = {
            hasOutputParsed: !!resp.output_parsed,
            outputsCount: Array.isArray(resp.output)
                ? resp.output.length
                : Array.isArray(resp.outputs)
                ? resp.outputs.length
                : null,
            firstOutputTypes:
                Array.isArray(resp.output) && resp.output[0]?.content
                    ? resp.output[0].content.map(p => p?.type)
                    : null,
        };
        console.warn(
            '[OpenAI debug] Could not find parsed JSON. Shape:',
            shape
        );
        throw new Error('OpenAI response was empty');
    }

    json = normalizeAudit(json);
    return json;
}

module.exports = { generateAudit };
