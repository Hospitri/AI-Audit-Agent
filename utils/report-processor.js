const OpenAI = require('openai');
const { pool: db } = require('./db.js');
const { WebClient } = require('@slack/web-api');

const TARGET_MODEL = 'gpt-4o-mini';
const MAX_TOKENS_PER_CHUNK = 4000;
const TARGET_CHANNEL_ID = process.env.SLACK_SUMMARY_CHANNEL;
const BATCH_DURATION_HOURS = 3;

const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

async function generateSubSummaries(messages, reportType) {
    const batches = createBatches(messages, BATCH_DURATION_HOURS);
    const subSummaries = [];

    const L1_SYSTEM_PROMPT = `You are a summary assistant. Your task is to process a batch of raw Slack communications. Filter out noise (repeated questions, greetings, reactions). Focus strictly on identifying: 1. Problems reported (with owner/property if mentioned). 2. Actions taken. 3. Pending items and next steps. Output only a concise summary of these points.`;

    for (const batch of batches) {
        const batchText = batch
            .map(msg => `${msg.user_id}: ${msg.message_text}`)
            .join('\n');

        try {
            const completion = await openai.chat.completions.create({
                model: TARGET_MODEL,
                messages: [
                    { role: 'system', content: L1_SYSTEM_PROMPT },
                    {
                        role: 'user',
                        content: `Process the following messages:\n\n${batchText}`,
                    },
                ],
                max_tokens: 500,
                temperature: 0.2,
            });
            subSummaries.push(completion.choices[0].message.content.trim());
        } catch (e) {
            console.error('[GPT_L1] Error generating sub-summary:', e.message);
            subSummaries.push(
                `[ERROR: Sub-summary failed for batch starting at ${new Date(
                    parseFloat(batch[0].message_ts) * 1000
                ).toISOString()}. Please check logs.]`
            );
        }
    }

    return subSummaries;
}

async function generateFinalReport(subSummaries, reportType) {
    const allSummariesText = subSummaries.join('\n---\n');

    const L2_SYSTEM_PROMPT = `You are an executive operations manager. You are receiving several daily summaries of Slack activity. Consolidate them into a final structured report. The report MUST be formatted strictly with the following three markdown headings: "Resolved Issues", "Pending / Escalated", and "Notable Events / Trends". Analyze the input to detect recurrence or critical nature. Output only the structured report text.`;

    try {
        const completion = await openai.chat.completions.create({
            model: TARGET_MODEL,
            messages: [
                { role: 'system', content: L2_SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: `Summaries to consolidate: \n\n${allSummariesText}`,
                },
            ],
            max_tokens: 1000,
            temperature: 0.1,
        });

        return completion.choices[0].message.content.trim();
    } catch (e) {
        console.error('[GPT_L2] Error generating final report:', e.message);
        return `Report Generation Failed for ${reportType}. Sub-summaries collected: ${subSummaries.length}`;
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
        console.error(
            '[Processor] DB Error fetching messages:',
            dbError.message
        );
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

    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    return batches;
}

async function publishReport(finalReportContent, reportType) {
    const reportTitle = `AI Daily Ops Digest – ${reportType} (${new Date().toDateString()})`;

    try {
        await slack.chat.postMessage({
            channel: TARGET_CHANNEL_ID,
            text: reportTitle,
            mrkdwn: true,
            attachments: [
                {
                    color: reportType === 'ON_HOURS' ? '#4CAF50' : '#FF9800',
                    title: reportTitle,
                    text: finalReportContent,
                    mrkdwn_in: ['text'],
                },
            ],
        });
        console.log(
            `[Processor] Report ${reportType} published successfully to Slack.`
        );
    } catch (e) {
        console.error(
            '[Processor] Failed to publish report to Slack:',
            e.message
        );
    }
}

async function markMessagesAsProcessed(messages, reportId) {
    if (messages.length === 0) return;

    const messageTSs = messages.map(msg => msg.message_ts);

    try {
        await db.query(
            `UPDATE slack_messages 
             SET processed_report_id = $1 
             WHERE message_ts = ANY($2::text[])`,
            [reportId, messageTSs]
        );
        console.log(
            `[Processor] ${messages.length} messages marked as processed.`
        );
    } catch (dbError) {
        console.error(
            '[Processor] Failed to mark messages as processed:',
            dbError.message
        );
    }
}

async function processReport(reportType) {
    console.log(`\n--- [REPORT START] Executing ${reportType} Report ---`);

    try {
        const { startTime, endTime } = getReportTimeRange(reportType);

        const messages = await fetchUnprocessedMessages(startTime, endTime);

        if (messages.length === 0) {
            const noActivityReport = `_No significant activity recorded between ${startTime.toLocaleTimeString()} and ${endTime.toLocaleTimeString()}._`;
            await publishReport(noActivityReport, reportType);
            console.log(
                `[Processor:${reportType}] Report finished: No activity.`
            );
            return;
        }

        const subSummaries = await generateSubSummaries(messages, reportType);

        const finalReportContent = await generateFinalReport(
            subSummaries,
            reportType
        );

        const reportId = `report-${reportType}-${Date.now()}`;

        await publishReport(finalReportContent, reportType);
        await markMessagesAsProcessed(messages, reportId);

        console.log(`[Processor:${reportType}] Report finished and published.`);
    } catch (error) {
        console.error(
            `[Processor:${reportType}] CRITICAL FAILURE during report generation:`,
            error.message
        );
    }

    console.log(`--- [REPORT END] ${reportType} Report Complete ---\n`);
}

module.exports = {
    processReport,
    getReportTimeRange,
    fetchUnprocessedMessages,
    markMessagesAsProcessed,
};
