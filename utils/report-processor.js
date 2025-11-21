const { Configuration, OpenAIApi } = require('openai');
const { pool: db } = require('./db.js');
const { WebClient } = require('@slack/web-api');

const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const TIMEZONE = 'America/Argentina/Buenos_Aires';
const BATCH_DURATION_HOURS = 3;
const TARGET_CHANNEL_ID = process.env.SLACK_SUMMARY_CHANNEL;

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
            `SELECT message_text, user_id, message_ts, thread_ts
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

async function publishReport(reportContent, reportType) {
    const reportTitle = `AI Daily Ops Digest – ${reportType} (${new Date().toDateString()})`;

    try {
        await slack.chat.postMessage({
            channel: TARGET_CHANNEL_ID,
            text: reportContent,
            mrkdwn: true,
            attachments: [
                {
                    color: reportType === 'ON_HOURS' ? '#4CAF50' : '#FF9800',
                    title: reportTitle,
                    text: reportContent,
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

    const messageIds = messages.map(msg => msg.id);

    try {
        await db.query(
            `UPDATE slack_messages 
             SET processed_report_id = $1 
             WHERE message_ts = ANY($2::text[])`,
            [reportId, messageIds]
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

async function generateSubSummaries(messages, reportType) {
    const batches = createBatches(messages, BATCH_DURATION_HOURS);
    const subSummaries = [];

    const L1_PROMPT = `You are a summary assistant. Your task is to process a batch of raw Slack communications. Filter out noise (repeated questions, excessive reactions, greetings). Focus on identifying problems reported, actions taken, and the current status of any pending item. Output only the summarized text. MESSAGES: \n\n`;

    for (const batch of batches) {
        const batchText = batch
            .map(msg => `${msg.user_id}: ${msg.message_text}`)
            .join('\n');

        try {
            const completion = await openai.createCompletion({
                model: 'text-davinci-003',
                prompt: L1_PROMPT + batchText,
                max_tokens: 500,
                temperature: 0.2,
            });
            subSummaries.push(completion.data.choices[0].text.trim());
        } catch (e) {
            console.error('[GPT_L1] Error generating sub-summary:', e.message);
            subSummaries.push(
                `[ERROR: Sub-summary failed for batch starting at ${new Date(
                    parseFloat(batch[0].message_ts) * 1000
                ).toISOString()}]`
            );
        }
    }

    return subSummaries;
}

async function generateFinalReport(subSummaries, reportType) {
    const allSummariesText = subSummaries.join('\n---\n');

    const L2_PROMPT = `You are an executive operations manager. You are receiving several daily summaries of Slack activity. Consolidate them into a final structured report. The report MUST be formatted strictly with the following three markdown headings: "Resolved Issues", "Pending / Escalated", and "Notable Events / Trends". Use clear, professional, and concise language. SUMMARIES TO CONSOLIDATE: \n\n${allSummariesText}`;

    try {
        const completion = await openai.createCompletion({
            model: 'text-davinci-003',
            prompt: L2_PROMPT,
            max_tokens: 1000,
            temperature: 0.1,
        });

        const reportContent = completion.data.choices[0].text.trim();

        return reportContent;
    } catch (e) {
        console.error('[GPT_L2] Error generating final report:', e.message);
        return `Report Generation Failed for ${reportType}. Please check logs. Sub-summaries collected: ${subSummaries.length}`;
    }
}

async function processReport(reportType) {
    console.log(`\n--- [REPORT START] Executing ${reportType} Report ---`);

    try {
        const { startTime, endTime } = getReportTimeRange(reportType);

        const messages = await fetchUnprocessedMessages(startTime, endTime);

        if (messages.length === 0) {
            const noActivityReport = `*AI Daily Ops Digest – ${reportType} (${new Date().toDateString()})*\n\n_No significant activity recorded between ${startTime.toLocaleTimeString()} and ${endTime.toLocaleTimeString()}._`;
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

        const finalReportWithTitle = `*AI Daily Ops Digest – ${reportType} (${new Date().toLocaleDateString(
            'en-US'
        )})*\n\n${finalReportContent}`;

        await publishReport(finalReportWithTitle, reportType);
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
