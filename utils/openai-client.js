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

const AUDIT_SCHEMA = {
    name: 'hospitri_listing_audit',
    schema: {
        type: 'object',
        additionalProperties: false,
        required: [
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
                        effort: {
                            type: 'string',
                            enum: ['Low', 'Med', 'High'],
                        },
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
    },
    strict: true,
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

function buildInputMessages(html, usePromptCache = false) {
    const systemMsg = {
        role: 'system',
        content: [
            {
                type: 'text',
                text: SYSTEM_PROMPT,
                ...(usePromptCache
                    ? { cache_control: { type: 'ephemeral' } }
                    : {}),
            },
        ],
    };
    const userMsg = {
        role: 'user',
        content: [
            { type: 'text', text: 'Extracted listing text (reduced):' },
            { type: 'text', text: html },
        ],
    };
    return [systemMsg, userMsg];
}

/**
 * Generates audit JSON with Responses API + json_schema
 * @param {{ html: string, model?: string }} param0
 */
async function generateAudit({
    html,
    model = process.env.OPENAI_MODEL || 'gpt-5-nano',
}) {
    const usePromptCache = process.env.OPENAI_PROMPT_CACHE === '1';
    const messages = buildInputMessages(html, usePromptCache);

    const resp = await client.responses.create({
        model,
        input: messages,
        temperature: 0.2,
        text: { format: { type: 'json_schema', json_schema: AUDIT_SCHEMA } },
        max_output_tokens: 900,
    });

    if (resp.usage) {
        console.log('[OpenAI usage]', {
            model: resp.model,
            input_tokens: resp.usage.input_tokens,
            output_tokens: resp.usage.output_tokens,
            total_tokens: resp.usage.total_tokens,
        });
    }

    const text = resp.output_text;
    if (!text) throw new Error('OpenAI response was empty');

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
