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

function constructSlackUrl(channelId, ts) {
    if (!channelId || !ts) return '';
    const cleanTs = ts.replace('.', '');
    return `https://slack.com/archives/${channelId}/p${cleanTs}`;
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
    1. Filter noise.
    2. Write a descriptive sentence of the issue/action.
    3. Extract Metadata: Property, Guest, Author.
    4. APPEND THE CONTEXT LINK: The input includes a "[Link: URL]" for messages. You MUST include this link at the end of the item using Slack syntax: <URL|View Context>.
    
    Format for each item:
    "[Description] (Prop: [Name], Guest: [Name], By: [Author Name]) <[URL]|View Context>"
    
    If multiple messages discuss the same issue, use the link from the first message.`;

    for (const batch of batches) {
        const batchLines = await Promise.all(
            batch.map(async msg => {
                const authorName = await resolveUserName(msg.user_id);
                const url = constructSlackUrl(msg.channel_id, msg.message_ts);
                return `Author ${authorName}: ${msg.message_text} [Link: ${url}]`;
            })
        );

        const batchText = batchLines.join('\n');

        try {
            const completion = await openai.chat.completions.create({
                model: TARGET_MODEL,
                messages: [
                    { role: 'system', content: L1_SYSTEM_PROMPT },
                    { role: 'user', content: `Summarize:\n\n${batchText}` },
                ],
                max_tokens: 800,
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

    const L2_SYSTEM_PROMPT = `You are an executive operations manager. Consolidate daily summaries.
    
    You will receive items like: "...description... (Context) <URL|View Context>".
    
    GOAL: Group items into the 3 sections below.
    CRITICAL: You MUST preserve the "<URL|View Context>" link at the end of every item.
    
    STRICT STRUCTURE:
    1. Not Attended
    2. Follow Up
    3. Resolved Issues

    Format: "- [Description] (Prop: X, Guest: Y, By: Z) <URL|View Context>"`;

    try {
        const completion = await openai.chat.completions.create({
            model: TARGET_MODEL,
            messages: [
                { role: 'system', content: L2_SYSTEM_PROMPT },
                { role: 'user', content: `Summaries:\n\n${allSummariesText}` },
            ],
            max_tokens: 1500,
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
