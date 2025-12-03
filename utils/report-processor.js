const OpenAI = require('openai');
const { pool: db } = require('./db.js');
const { WebClient } = require('@slack/web-api');

const TARGET_MODEL = 'gpt-4o-mini';
const TARGET_CHANNEL_ID = process.env.SLACK_SUMMARY_CHANNEL;
const BATCH_DURATION_HOURS = 3;

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const userCache = new Map();

async function resolveUserName(userId) {
    if (userCache.has(userId)) return userCache.get(userId);
    try {
        const response = await slack.users.info({ user: userId });
        if (response.ok && response.user) {
            const realName =
                response.user.profile.display_name ||
                response.user.profile.real_name ||
                response.user.name;
            userCache.set(userId, realName);
            return realName;
        }
    } catch (error) {
        console.warn(
            `[Processor] Could not resolve user ${userId}:`,
            error.message
        );
    }
    return userId;
}

function getSlackUrl(channelId, ts) {
    if (!channelId || !ts) return '#';
    return `https://slack.com/archives/${channelId}/p${ts.replace('.', '')}`;
}

function formatJsonToBlocks(reportData, reportType) {
    const typeLabel = reportType === 'ON_HOURS' ? 'On-Hours' : 'Off-Hours';
    const dateStr = new Date().toLocaleDateString('en-US');

    const blocks = [
        {
            type: 'header',
            text: {
                type: 'plain_text',
                text: `📊 Daily Ops Digest - ${typeLabel} (${dateStr})`,
                emoji: true,
            },
        },
        { type: 'divider' },
    ];

    const generateSectionBlocks = (title, items) => {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: title },
        });

        if (!items || items.length === 0) {
            blocks.push({
                type: 'context',
                elements: [
                    { type: 'mrkdwn', text: '_No items in this category._' },
                ],
            });
            return;
        }

        items.forEach(item => {
            let summary = item.summary.replace(/^["'-]/, '').trim();

            let text = `• ${summary}`;

            let contextParts = [];

            if (
                item.property &&
                item.property !== 'N/A' &&
                item.property !== 'Unknown'
            )
                contextParts.push(`🏠 *Prop:* ${item.property}`);

            if (item.guest && item.guest !== 'N/A' && item.guest !== 'Unknown')
                contextParts.push(`👤 *Guest:* ${item.guest}`);

            if (item.author && item.author !== 'N/A')
                contextParts.push(`✍️ *By:* ${item.author}`);

            let linkText = '';
            if (item.link && item.link !== '#') {
                linkText = `  🔗 <${item.link}|View Context>`;
            }

            if (contextParts.length > 0) {
                text += `\n\t${contextParts.join('  |  ')}${linkText}`;
            } else if (linkText) {
                text += `\n\t${linkText.trim()}`;
            }

            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: text },
            });
        });
    };

    generateSectionBlocks('*🚨 Not Attended*', reportData.not_attended);
    blocks.push({ type: 'divider' });

    generateSectionBlocks('*⚠️ Follow Up*', reportData.follow_up);
    blocks.push({ type: 'divider' });

    generateSectionBlocks('*✅ Resolved Issues*', reportData.resolved_issues);

    return blocks;
}

async function generateSubSummaries(messages) {
    const batches = createBatches(messages, BATCH_DURATION_HOURS);
    const subSummaries = [];

    const L1_SYSTEM_PROMPT = `You are an expert operational analyst.
    Task: Summarize Slack conversations into concise, executive-level status updates.
    
    INPUT FORMAT:
    "Author [Name]: [Message] [[LINK_URL]]"
    
    REQUIREMENTS:
    1. **Summarize, Don't Quote:** Do NOT copy the message text. Rewrite it in 3rd person description.
       - BAD: "we are trying to reach out..."
       - GOOD: "The team is contacting the cleaning crew regarding..."
    2. **Extract Metadata:** Identify Property, Guest, and Author. Infer from context if not explicit.
    3. **Link Preservation:** You MUST include the exact "[[LINK_URL]]" string provided in the input at the end of your summary item.
    
    OUTPUT FORMAT (One line per issue):
    "Issue: [Executive Summary] | Prop: [Name] | Guest: [Name] | Auth: [Name] | Link: [[LINK_URL]]"
    `;

    for (const batch of batches) {
        const batchLines = await Promise.all(
            batch.map(async msg => {
                const authorName = await resolveUserName(msg.user_id);
                const url = getSlackUrl(msg.channel_id, msg.message_ts);
                return `Author ${authorName}: ${msg.message_text} [[${url}]]`;
            })
        );

        const batchText = batchLines.join('\n\n');

        try {
            const completion = await openai.chat.completions.create({
                model: TARGET_MODEL,
                messages: [
                    { role: 'system', content: L1_SYSTEM_PROMPT },
                    {
                        role: 'user',
                        content: `Process these messages:\n\n${batchText}`,
                    },
                ],
                max_tokens: 1000,
                temperature: 0.1,
            });
            subSummaries.push(completion.choices[0].message.content.trim());
        } catch (e) {
            console.error('[GPT_L1] Error:', e.message);
            subSummaries.push(`[ERROR processing batch]`);
        }
    }
    return subSummaries;
}

async function generateFinalReport(subSummaries, reportType) {
    const allSummariesText = subSummaries.join('\n---\n');

    const L2_SYSTEM_PROMPT = `You are an Operations Director. Create the Daily Ops Digest JSON.
    
    INPUT: A list of summarized issues like: "Issue: ... | Prop: ... | Link: [[URL]]"
    
    TASK: Group these issues into 3 categories based on their status.
    
    DEFINITIONS:
    1. **not_attended**: Issues that have been raised but show NO evidence of a reply or action taken yet.
    2. **follow_up**: Issues that are being worked on, are waiting for a reply (from guest/owner), or need monitoring.
    3. **resolved_issues**: Issues explicitly marked as done, fixed, or closed.

    OUTPUT: Return ONLY a valid JSON object with this structure:
    {
      "not_attended": [ { "summary": string, "property": string, "guest": string, "author": string, "link": string } ],
      "follow_up": [ ... ],
      "resolved_issues": [ ... ]
    }

    RULES:
    - **Link:** Extract the URL from the "[[URL]]" tag in the input and put it in the "link" field.
    - **Summary:** Use professional, executive language. No "I" or "We". Use "The team", "Staff", etc.
    - **Missing Data:** If Property or Guest is not found, use "N/A".
    `;

    try {
        const completion = await openai.chat.completions.create({
            model: TARGET_MODEL,
            messages: [
                { role: 'system', content: L2_SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: `Data to process:\n\n${allSummariesText}`,
                },
            ],
            response_format: { type: 'json_object' },
            max_tokens: 2500,
            temperature: 0.1,
        });

        const jsonResponse = JSON.parse(completion.choices[0].message.content);
        return jsonResponse;
    } catch (e) {
        console.error('[GPT_L2] Error generating final report:', e.message);
        return {
            not_attended: [],
            follow_up: [
                {
                    summary:
                        'Error generating report content via AI. Check logs.',
                    author: 'System',
                    link: '#',
                },
            ],
            resolved_issues: [],
        };
    }
}

function getReportTimeRange(reportType) {
    const now = new Date();
    let startTime, endTime;

    if (reportType === 'ON_HOURS') {
        endTime = new Date(now.setHours(18, 0, 0, 0));
        startTime = new Date(now.setHours(9, 0, 0, 0));
    } else {
        endTime = new Date(now.setHours(9, 0, 0, 0));

        startTime = new Date(now);
        startTime.setDate(now.getDate() - 1);
        startTime.setHours(18, 0, 0, 0);
    }

    return { startTime, endTime };
}

async function fetchUnprocessedMessages(startTime, endTime) {
    try {
        const result = await db.query(
            `SELECT message_text, user_id, message_ts, thread_ts, id, channel_id
             FROM slack_messages 
             WHERE created_at >= $1 
               AND created_at < $2 
               AND processed_report_id IS NULL
             ORDER BY message_ts ASC`,
            [startTime, endTime]
        );

        return result.rows;
    } catch (dbError) {
        console.error('[Processor] DB Error:', dbError.message);
        return [];
    }
}

function createBatches(messages, durationHours) {
    if (messages.length === 0) return [];

    const batches = [];
    let currentBatch = [];

    let currentBatchTime = parseFloat(messages[0].message_ts) * 1000;
    const batchDurationMs = durationHours * 60 * 60 * 1000;

    messages.forEach(msg => {
        const msgTime = parseFloat(msg.message_ts) * 1000;

        if (currentBatch.length === 0) {
            currentBatch.push(msg);
            currentBatchTime = msgTime;
        } else if (msgTime - currentBatchTime < batchDurationMs) {
            currentBatch.push(msg);
        } else {
            batches.push(currentBatch);
            currentBatch = [msg];
            currentBatchTime = msgTime;
        }
    });
    if (currentBatch.length > 0) batches.push(currentBatch);
    return batches;
}

async function publishReport(reportData, reportType) {
    const blocks = formatJsonToBlocks(reportData, reportType);

    const typeLabel = reportType === 'ON_HOURS' ? 'On-Hours' : 'Off-Hours';

    try {
        await slack.chat.postMessage({
            channel: TARGET_CHANNEL_ID,
            blocks: blocks,
            text: `Daily Ops Digest - ${typeLabel}`,
            mrkdwn: true,
        });
        console.log(`[Processor] Report ${reportType} published to Slack.`);
    } catch (e) {
        console.error('[Processor] Failed to publish:', e.message);
    }
}

async function markMessagesAsProcessed(messages, reportId) {
    if (messages.length === 0) return;
    const messageTSs = messages.map(msg => msg.message_ts);
    try {
        await db.query(
            `UPDATE slack_messages SET processed_report_id = $1 WHERE message_ts = ANY($2::text[])`,
            [reportId, messageTSs]
        );
        console.log(
            `[Processor] ${messages.length} messages marked processed.`
        );
    } catch (dbError) {
        console.error('[Processor] Failed to mark processed:', dbError.message);
    }
}

async function processReport(reportType) {
    console.log(`\n--- [REPORT START] Executing ${reportType} Report ---`);
    try {
        const { startTime, endTime } = getReportTimeRange(reportType);
        const messages = await fetchUnprocessedMessages(startTime, endTime);

        if (messages.length === 0) {
            const typeLabel =
                reportType === 'ON_HOURS' ? 'On-Hours' : 'Off-Hours';
            const blocks = [
                {
                    type: 'header',
                    text: {
                        type: 'plain_text',
                        text: `📊 Daily Ops Digest - ${typeLabel} (${new Date().toLocaleDateString(
                            'en-US'
                        )})`,
                        emoji: true,
                    },
                },
                { type: 'divider' },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `_No significant activity recorded between ${startTime.toLocaleTimeString()} and ${endTime.toLocaleTimeString()}._`,
                    },
                },
            ];

            await slack.chat.postMessage({
                channel: TARGET_CHANNEL_ID,
                blocks: blocks,
                text: `Daily Ops Digest - ${typeLabel}`,
            });

            console.log(`[Processor:${reportType}] No new messages.`);
            return;
        }

        const subSummaries = await generateSubSummaries(messages);
        const finalReportData = await generateFinalReport(
            subSummaries,
            reportType
        );

        await publishReport(finalReportData, reportType);

        // await markMessagesAsProcessed(messages, `report-${reportType}-${Date.now()}`);

        console.log(`[Processor:${reportType}] Finished.`);
    } catch (error) {
        console.error(
            `[Processor:${reportType}] CRITICAL FAILURE:`,
            error.message
        );
    }
    console.log(`--- [REPORT END] ---\n`);
}

module.exports = {
    processReport,
    getReportTimeRange,
    fetchUnprocessedMessages,
    markMessagesAsProcessed,
};
