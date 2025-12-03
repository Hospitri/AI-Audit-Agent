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

function constructSlackUrl(channelId, ts) {
    if (!channelId || !ts) return '';
    const cleanTs = ts.replace('.', '');
    return `https://slack.com/archives/${channelId}/p${cleanTs}`;
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
                type: 'section',
                text: { type: 'mrkdwn', text: '_None_' },
            });
            return;
        }

        items.forEach(item => {
            let text = `• ${item.summary}`;

            if (item.property && item.property !== 'N/A')
                text += `\n\t🏠 *Prop:* ${item.property}`;
            if (item.guest && item.guest !== 'N/A')
                text += `\n\t👤 *Guest:* ${item.guest}`;
            if (item.author && item.author !== 'N/A')
                text += `\n\t✍️ *By:* ${item.author}`;

            if (item.link) text += `\n\t🔗 <${item.link}|View Context>`;

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

    const L1_SYSTEM_PROMPT = `You are an operational data extraction assistant.
    Task: Read Slack messages and extract key info.
    
    CRITICAL LOGIC FOR "ESCALATION NOTIFICATIONS":
    If a message starts with ":rotating_light: *New Escalation Submitted*" or similar bot structure:
    1. IGNORE the "Slack User ID" provided in the meta-header.
    2. INSTEAD, extract the author from the text field "Submitted by:".
    3. Extract Property from "Listing:".
    4. Extract Guest from "Guest:".
    5. Use "Summary:" as the issue description.

    FOR REGULAR MESSAGES:
    1. Use the provided Author Name.
    2. Infer Property/Guest from context.

    Output Format per item:
    "Issue: [Description] | Prop: [Name] | Guest: [Name] | Auth: [Name] | Link: [URL]"
    `;

    for (const batch of batches) {
        const batchLines = await Promise.all(
            batch.map(async msg => {
                const authorName = await resolveUserName(msg.user_id);
                const url = constructSlackUrl(msg.channel_id, msg.message_ts);
                return `[Meta: UserID=${msg.user_id}, Name=${authorName}, Link=${url}] Content: ${msg.message_text}`;
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
                        content: `Extract info from these messages:\n\n${batchText}`,
                    },
                ],
                max_tokens: 800,
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

    const L2_SYSTEM_PROMPT = `You are an executive operations manager. 
    Consolidate the provided summaries into a structured JSON report.
    
    Goal: Group items into 3 categories.
    
    Categories:
    1. not_attended: Issues requiring immediate attention where NO action/reply was recorded yet.
    2. follow_up: Issues pending action, waiting for reply, or in progress.
    3. resolved_issues: Completed items.

    Input format received: "Issue: ... | Prop: ... | Guest: ... | Auth: ... | Link: ..."
    
    Output JSON Structure:
    {
      "not_attended": [ { "summary": string, "property": string, "guest": string, "author": string, "link": string } ],
      "follow_up": [ ... ],
      "resolved_issues": [ ... ]
    }

    Rules:
    - "summary": Concise description of the issue/action. Clean text, no brackets.
    - "author": The name of the person who raised the issue (or 'Submitted by' if it was a bot ticket).
    - "link": The Slack URL provided in input.
    - If property/guest/author is missing, use "N/A".
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
            max_tokens: 2000,
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
                    summary: 'Error generating report content via AI.',
                    author: 'System',
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
    const fallbackText = `Daily Ops Digest - ${typeLabel}`;

    try {
        await slack.chat.postMessage({
            channel: TARGET_CHANNEL_ID,
            blocks: blocks,
            text: fallbackText,
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
