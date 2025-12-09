const OpenAI = require('openai');
const { pool: db } = require('./db.js');
const { WebClient } = require('@slack/web-api');
const { Client: NotionClient } = require('@notionhq/client');

const TARGET_MODEL = 'gpt-5-nano';
const TARGET_CHANNEL_ID = process.env.SLACK_SUMMARY_CHANNEL;
const NOTION_DB_ID = process.env.NOTION_SUMMARY_DB_ID;
const BATCH_DURATION_HOURS = 3;

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const notion = new NotionClient({
    auth: process.env.NOTION_API_KEY || process.env.NOTION_TOKEN,
});

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
                contextParts.push(`*Prop:* ${item.property}`);

            if (item.guest && item.guest !== 'N/A' && item.guest !== 'Unknown')
                contextParts.push(`*Guest:* ${item.guest}`);

            if (item.author && item.author !== 'N/A')
                contextParts.push(`*By:* ${item.author}`);

            let linkText = '';
            if (item.link && item.link !== '#') {
                linkText = `  <${item.link}|View Context>`;
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

function convertJsonReportToText(reportData) {
    let text = '';

    const appendSection = (title, items) => {
        text += `${title}\n`;
        if (!items || items.length === 0) {
            text += '- None\n\n';
            return;
        }
        items.forEach(item => {
            text += `- ${item.summary} (Prop: ${item.property}, Guest: ${item.guest}, By: ${item.author})\n`;
        });
        text += '\n';
    };

    appendSection('🚨 Not Attended', reportData.not_attended);
    appendSection('⚠️ Follow Up', reportData.follow_up);
    appendSection('✅ Resolved Issues', reportData.resolved_issues);

    return text;
}

async function saveReportToNotion(finalReportContent, reportType) {
    if (!NOTION_DB_ID) {
        console.warn(
            '[Processor] NOTION_SUMMARY_DB_ID not set. Skipping Notion save.'
        );
        return;
    }

    const typeLabel = reportType === 'ON_HOURS' ? 'On-hours' : 'Off-hours';
    const title = `Ops Digest - ${new Date().toLocaleDateString('en-US')}`;

    const contentTruncated =
        finalReportContent.length > 2000
            ? finalReportContent.substring(0, 1997) + '...'
            : finalReportContent;

    try {
        await notion.pages.create({
            parent: { database_id: NOTION_DB_ID },
            properties: {
                ID: {
                    title: [{ text: { content: title } }],
                },
                Type: {
                    select: {
                        name: typeLabel,
                    },
                },
                Timestamp: {
                    date: {
                        start: new Date().toISOString(),
                    },
                },
                Report: {
                    rich_text: [{ text: { content: contentTruncated } }],
                },
            },
            children: [
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [
                            {
                                type: 'text',
                                text: {
                                    content: finalReportContent.substring(
                                        0,
                                        2000
                                    ),
                                },
                            },
                        ],
                    },
                },
            ],
        });
        console.log(`[Processor] Report saved to Notion successfully.`);
    } catch (error) {
        console.error(
            '[Processor] Failed to save report to Notion:',
            error.body || error.message
        );
    }
}

async function generateSubSummaries(messages) {
    const batches = createBatches(messages, BATCH_DURATION_HOURS);
    const subSummaries = [];

    const L1_SYSTEM_PROMPT = `You are an expert operational analyst.
    Task: Summarize Slack conversations into concise, executive-level status updates.
    
    INPUT FORMAT:
    "Author [Name]: [Message] [[LINK_URL]]"
    
    REQUIREMENTS:
    1. **Summarize, Don't Quote:** Rewrite content in 3rd person description (e.g., "The team is contacting...").
    2. **Extract Metadata:** Identify Property, Guest, and Author. Infer from context.
    3. **CRITICAL - LINK HANDLING:** The input ends with a tag like [[https://...]]. You MUST copy this tag EXACTLY as is to the output. Do NOT alter it, do NOT shorten it, and do NOT invent a new one. Treat it as a unique ID.
    
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
                    { role: 'user', content: `Summarize:\n\n${batchText}` },
                ],
                max_tokens: 1000,
                reasoning_effort: 'low',
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
    
    TASK: Group these issues into 3 categories (not_attended, follow_up, resolved_issues).
    
    OUTPUT: Return ONLY a valid JSON object.
    STRUCTURE: { "not_attended": [...], "follow_up": [...], "resolved_issues": [...] }
    
    RULES:
    - **Link:** Extract the URL strictly from the "[[URL]]" tag in the input. If the input link looks broken or is missing, use "#". NEVER invent a URL.
    - **Summary:** Use professional, executive language.
    - **Missing Data:** If Property or Guest is not found, use "N/A".
    `;

    try {
        const completion = await openai.chat.completions.create({
            model: TARGET_MODEL,
            messages: [
                { role: 'system', content: L2_SYSTEM_PROMPT },
                { role: 'user', content: `Summaries:\n\n${allSummariesText}` },
            ],
            response_format: { type: 'json_object' },
            max_tokens: 2500,
            reasoning_effort: 'low',
        });
        return completion.choices[0].message.content.trim();
    } catch (e) {
        console.error('[GPT_L2] Error generating final report:', e.message);
        return {
            not_attended: [],
            follow_up: [
                {
                    summary: 'Error generating report content via AI.',
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
    const dayOfWeek = now.getDay();

    let startTime, endTime;

    if (reportType === 'ON_HOURS') {
        endTime = new Date(now.setHours(18, 0, 0, 0));
        startTime = new Date(now.setHours(9, 0, 0, 0));
    } else {
        endTime = new Date(now.setHours(9, 0, 0, 0));

        const daysBack = dayOfWeek === 1 ? 3 : 1;

        startTime = new Date(now);
        startTime.setDate(now.getDate() - daysBack);
        startTime.setHours(18, 0, 0, 0);
    }

    return { startTime, endTime };
}

async function fetchUnprocessedMessages(startTime, endTime) {
    try {
        const result = await db.query(
            `SELECT message_text, user_id, message_ts, thread_ts, id, channel_id
             FROM slack_messages 
             WHERE created_at >= $1 AND created_at < $2 AND processed_report_id IS NULL
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
            const emptyMsg = `_No significant activity recorded between ${startTime.toLocaleTimeString()} and ${endTime.toLocaleTimeString()}._`;

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
                        text: emptyMsg,
                    },
                },
            ];

            await slack.chat.postMessage({
                channel: TARGET_CHANNEL_ID,
                blocks: blocks,
                text: `Daily Ops Digest - ${typeLabel}`,
            });

            await saveReportToNotion(
                'No significant activity recorded.',
                reportType
            );

            console.log(`[Processor:${reportType}] No new messages.`);
            return;
        }

        const subSummaries = await generateSubSummaries(messages);
        const finalReportData = await generateFinalReport(
            subSummaries,
            reportType
        );

        await publishReport(finalReportData, reportType);

        const textReportForNotion = convertJsonReportToText(finalReportData);
        await saveReportToNotion(textReportForNotion, reportType);

        const reportId = `report-${reportType}-${Date.now()}`;
        // await markMessagesAsProcessed(messages, reportId);

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
