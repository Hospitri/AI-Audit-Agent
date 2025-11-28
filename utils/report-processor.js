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

function getUsernameFromId(userId) {
    return userId;
}

async function generateSubSummaries(messages) {
    const batches = createBatches(messages, BATCH_DURATION_HOURS);
    const subSummaries = [];

    const L1_SYSTEM_PROMPT = `You are a strict data extraction assistant. 
    Process these Slack messages and summarize distinct operational issues.
    
    CRITICAL REQUIREMENTS:
    1. Filter noise (greetings, reactions).
    2. For EVERY issue, you MUST extract:
       - Property Name (if mentioned/inferred)
       - Guest Name (if mentioned/inferred)
       - Author Name (The Slack ID provided in input)
    3. Status classification: Is this 'Not Attended' (nobody replied/acted), 'Follow Up' (in progress/waiting), or 'Resolved'?
    
    Output format: A concise summary paragraph per issue containing the context and the status.`;

    for (const batch of batches) {
        const batchText = batch
            .map(msg => `Author ${msg.user_id}: ${msg.message_text}`)
            .join('\n');

        try {
            const completion = await openai.chat.completions.create({
                model: TARGET_MODEL,
                messages: [
                    { role: 'system', content: L1_SYSTEM_PROMPT },
                    { role: 'user', content: `Messages:\n\n${batchText}` },
                ],
                max_tokens: 600,
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

    const L2_SYSTEM_PROMPT = `You are an executive operations manager. Consolidate the daily summaries into a final report.
    
    STRICT OUTPUT STRUCTURE (Do not use Markdown Headers like #, just use the exact titles below):
    
    1. Not Attended
    (List critical issues where no action was taken yet. MUST include Property, Guest, and Author).
    
    2. Follow Up
    (List ongoing issues requiring action/waiting. MUST include Property, Guest, and Author).
    
    3. Resolved Issues
    (List completed items. MUST include Property, Guest, and Author).

    Style: Use bullet points. Be professional and concise. Do NOT tag users (e.g. @U123), just display the name/ID as string.`;

    try {
        const completion = await openai.chat.completions.create({
            model: TARGET_MODEL,
            messages: [
                { role: 'system', content: L2_SYSTEM_PROMPT },
                { role: 'user', content: `Summaries:\n\n${allSummariesText}` },
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

    const fallbackText = `Daily Ops Digest - ${
        reportType === 'ON_HOURS' ? 'On-Hours' : 'Off-Hours'
    }`;

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
            const emptyMsg = `_No significant activity recorded between ${startTime.toLocaleTimeString()} and ${endTime.toLocaleTimeString()}._`;

            await publishReport(emptyMsg, reportType);

            console.log(`[Processor:${reportType}] No new messages.`);
            return;
        }

        const subSummaries = await generateSubSummaries(messages);
        const finalReportContent = await generateFinalReport(
            subSummaries,
            reportType
        );

        await publishReport(finalReportContent, reportType);

        const reportId = `report-${reportType}-${Date.now()}`;
        await markMessagesAsProcessed(messages, reportId);

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
