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
        what_works: { type: 'string', maxLength: 40 },
        what_to_improve: { type: 'string', maxLength: 40 },
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
    'Round overall_score to ONE decimal.',
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

function extractOutputText(resp) {
    if (typeof resp.output_text === 'string' && resp.output_text.trim()) {
        return resp.output_text;
    }

    const outputs = resp.output || resp.outputs || [];
    for (const item of outputs) {
        const parts = item.content || [];
        for (const part of parts) {
            if (part?.type === 'output_text') {
                if (typeof part.text === 'string') return part.text;
                if (part.text && typeof part.text.value === 'string')
                    return part.text.value;
            }
            if (part?.type === 'text') {
                if (typeof part.text === 'string') return part.text;
                if (part.text && typeof part.text.value === 'string')
                    return part.text.value;
            }
        }
    }

    try {
        const maybe = outputs?.[0]?.content
            ?.map(p => p?.text?.value || p?.text)
            .filter(Boolean)
            .join('\n');
        if (maybe && maybe.trim()) return maybe;
    } catch (_) {}

    return null;
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
        max_output_tokens: 1500,
    });

    if (resp.usage) {
        console.log('[OpenAI usage]', {
            model: resp.model,
            input_tokens: resp.usage.input_tokens,
            output_tokens: resp.usage.output_tokens,
            total_tokens: resp.usage.total_tokens,
        });
    }

    const text = extractOutputText(resp);
    if (!text || !text.trim()) {
        console.warn('[OpenAI debug] No output_text found. Shapes:', {
            hasOutputText: typeof resp.output_text === 'string',
            outputLen: Array.isArray(resp.output) ? resp.output.length : null,
        });
        throw new Error('OpenAI response was empty');
    }

    let json;
    try {
        json = JSON.parse(text);
    } catch (err) {
        console.error('Failed to parse model JSON:', text);
        throw err;
    }

    return json;
}

module.exports = { generateAudit };
