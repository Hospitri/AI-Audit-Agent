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
    if (userCache.has(userId)) {
        return userCache.get(userId);
    }
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

function formatGptContentToBlocks(reportContent, reportType) {
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

    const lines = reportContent
        .split('\n')
        .filter(line => line.trim().length > 0);

    let currentSectionText = '';

    const pushSection = text => {
        if (text.trim()) {
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: text.trim() },
            });
        }
    };

    lines.forEach(line => {
        const lowerLine = line.toLowerCase();

        if (lowerLine.includes('not attended')) {
            pushSection(currentSectionText);
            currentSectionText = '';
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: '*🚨 Not Attended*' },
            });
        } else if (lowerLine.includes('follow up')) {
            pushSection(currentSectionText);
            currentSectionText = '';
            blocks.push({ type: 'divider' });
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: '*⚠️ Follow Up*' },
            });
        } else if (lowerLine.includes('resolved issues')) {
            pushSection(currentSectionText);
            currentSectionText = '';
            blocks.push({ type: 'divider' });
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: '*✅ Resolved Issues*' },
            });
        } else {
            if (line.trim().match(/^[-*]/)) {
                currentSectionText += `${line.trim()}\n`;
            } else {
                currentSectionText += `${line.trim()}\n`;
            }
        }
    });

    pushSection(currentSectionText);

    if (blocks.length <= 2) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: reportContent },
        });
    }

    return blocks;
}

async function generateSubSummaries(messages) {
    const batches = createBatches(messages, BATCH_DURATION_HOURS);
    const subSummaries = [];

    const L1_SYSTEM_PROMPT = `You are an operational summary assistant. 
    Task: Read the raw Slack messages and generate concise summaries.
    
    CRITICAL INSTRUCTION:
    Do NOT just list the metadata. You MUST write a sentence describing the issue or action taken.
    
    Format for each item:
    "[Description of what happened] (Prop: [Name], Guest: [Name], By: [Author Name])"
    
    If Property or Guest are unknown, write "N/A".`;

    for (const batch of batches) {
        const batchLines = await Promise.all(
            batch.map(async msg => {
                const authorName = await resolveUserName(msg.user_id);
                return `Author ${authorName}: ${msg.message_text}`;
            })
        );

        const batchText = batchLines.join('\n');

        try {
            const completion = await openai.chat.completions.create({
                model: TARGET_MODEL,
                messages: [
                    { role: 'system', content: L1_SYSTEM_PROMPT },
                    {
                        role: 'user',
                        content: `Summarize these messages maintaining context:\n\n${batchText}`,
                    },
                ],
                max_tokens: 600,
                temperature: 0.2,
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

    const L2_SYSTEM_PROMPT = `You are an executive operations manager. Consolidate the daily summaries into a final report.
    
    You will receive summaries that look like: "Issue description... (Prop: X, Guest: Y, By: Name)".
    
    YOUR GOAL: Group these items into the following 3 sections based on their status. Keep the description AND the context details in the same line.
    
    STRICT OUTPUT STRUCTURE:
    
    1. Not Attended
    (List items where NO action/reply was recorded. Format: "- [Issue description] (Prop: [Name], Guest: [Name], By: [Name])")
    
    2. Follow Up
    (List items pending action/waiting. Format: "- [Issue description] (Prop: [Name], Guest: [Name], By: [Name])")
    
    3. Resolved Issues
    (List completed items. Format: "- [Resolution description] (Prop: [Name], Guest: [Name], By: [Name])")

    General Rules:
    - Use bullet points.
    - Be concise but descriptive.
    - Do NOT output "None" if there is data. If a section is empty, write "None".`;

    try {
        const completion = await openai.chat.completions.create({
            model: TARGET_MODEL,
            messages: [
                { role: 'system', content: L2_SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: `Summaries to consolidate:\n\n${allSummariesText}`,
                },
            ],
            max_tokens: 1200,
            temperature: 0.1,
        });
        return completion.choices[0].message.content.trim();
    } catch (e) {
        console.error('[GPT_L2] Error:', e.message);
        return `Report Generation Failed.`;
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
            `SELECT message_text, user_id, message_ts, thread_ts, id
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

async function publishReport(finalReportContent, reportType) {
    const blocks = formatGptContentToBlocks(finalReportContent, reportType);

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
        const finalReportContent = await generateFinalReport(
            subSummaries,
            reportType
        );

        await publishReport(finalReportContent, reportType);

        // await markMessagesAsProcessed(
        //     messages,
        //     `report-${reportType}-${Date.now()}`
        // );

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
