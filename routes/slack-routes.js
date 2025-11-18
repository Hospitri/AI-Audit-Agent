const express = require('express');
const crypto = require('crypto');
const { WebClient } = require('@slack/web-api');
const bodyParser = require('body-parser');
const axios = require('axios');
const { pool: db } = require('../db');
const {
    createNotionTicket,
    updateNotionTicketWithThread,
    getNotionUserIdByEmail,
} = require('../utils/notion-escalations.js');

const router = express.Router();
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

let BOT_USER_ID = null;

async function getBotUserId() {
    if (BOT_USER_ID) return BOT_USER_ID;
    try {
        const authTest = await slack.auth.test();
        BOT_USER_ID = authTest.user_id;
        console.log(`[slack] Bot User ID cached: ${BOT_USER_ID}`);
        return BOT_USER_ID;
    } catch (e) {
        console.error('[slack] Could not get bot user ID via auth.test', e);
        return null;
    }
}

async function findMessageTsInHistory(channel, botId, fileId, retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            const history = await slack.conversations.history({
                channel: channel,
                limit: 10,
            });

            const sentMessage = history.messages.find(
                m => m.user === botId && m.files?.some(f => f.id === fileId)
            );

            if (sentMessage) {
                console.log(
                    `[slack] Found message in history on attempt ${
                        i + 1
                    } with ts: ${sentMessage.ts}`
                );
                return sentMessage.ts;
            }

            console.warn(
                `[slack] Message (fileId: ${fileId}) not found on attempt ${
                    i + 1
                }. Retrying...`
            );
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (historyErr) {
            console.error(
                '[slack] Error fetching channel history:',
                historyErr?.data || historyErr
            );
            return null;
        }
    }

    console.error(
        `[slack] Could not find message with file ID ${fileId} after ${retries} attempts.`
    );
    return null;
}

function timingSafeCompare(a, b) {
    try {
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
        return false;
    }
}

function verifySlackSignature(rawBody, req) {
    const ts = req.headers['x-slack-request-timestamp'];
    const sig = req.headers['x-slack-signature'];
    if (!ts || !sig) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > 60 * 5)
        return false;
    const base = `v0:${ts}:${rawBody}`;
    const hmac = crypto
        .createHmac('sha256', SIGNING_SECRET)
        .update(base)
        .digest('hex');
    const computed = `v0=${hmac}`;
    return timingSafeCompare(computed, sig);
}

function buildMarkdownText(data) {
    const {
        booking,
        listing,
        guest,
        issues = [],
        summary,
        assignees = [],
        submittedByName,
        notionUrl,
    } = data;

    const assigneesText = assignees.map(id => `<@${id}>`).join(', ') || '-';

    return `:rotating_light: *New Escalation Submitted*
*Booking reference:* ${booking || '-'}
*Listing:* ${listing || '-'}
*Guest:* ${guest || '-'}
*Issue type:* ${(issues || []).join(', ') || '-'}
*Summary:*
${summary || '-'}
––––––––––––––––––––––––––––––––––––––––
*Assigned to:* ${assigneesText}
*Submitted by:* ${submittedByName}
<${notionUrl}|Open ticket in Notion>

Please reply to this message in thread with any relevant update.`;
}

router.post(
    '/interactivity',
    bodyParser.raw({ type: '*/*' }),
    async (req, res) => {
        try {
            const raw = req.body.toString('utf8');
            if (!verifySlackSignature(raw, req)) {
                return res.status(400).send('invalid signature');
            }

            const params = new URLSearchParams(raw);
            const payloadStr = params.get('payload');
            if (!payloadStr) return res.status(400).send('missing payload');

            let payload;
            try {
                payload = JSON.parse(payloadStr);
            } catch (err) {
                return res.status(400).send('bad payload');
            }

            if (
                payload.type === 'view_submission' &&
                payload.view?.callback_id === 'escalation_modal'
            ) {
                res.status(200).json({ response_action: 'clear' });

                (async () => {
                    try {
                        await getBotUserId();
                        const vals = payload.view.state.values || {};
                        const booking =
                            vals.booking?.booking_ref?.value || null;
                        const listing =
                            vals.listing?.listing_name?.value || null;
                        const guest = vals.guest?.guest_name?.value || null;
                        const summary = vals.summary?.summary?.value || null;
                        const issues = (
                            vals.issue?.issue_type?.selected_options || []
                        ).map(o => o.value);
                        const assignees =
                            vals.assign?.assignees?.selected_users || [];
                        const submittedBySlackId = payload.user?.id || null;

                        const filesSelected =
                            vals.input_block_id?.file_input_action_id_1
                                ?.files || [];
                        const attachments_present = filesSelected.length > 0;
                        const firstFile = attachments_present
                            ? filesSelected[0]
                            : null;

                        const assigneeSlackInfos = [];
                        for (const sid of assignees) {
                            try {
                                const u = await slack.users.info({ user: sid });
                                const profile = u?.user?.profile || {};
                                assigneeSlackInfos.push({
                                    slackId: sid,
                                    email: profile.email || null,
                                    name:
                                        profile.display_name ||
                                        profile.real_name ||
                                        `<@${sid}>`,
                                });
                            } catch (e) {
                                assigneeSlackInfos.push({
                                    slackId: sid,
                                    email: null,
                                    name: `<@${sid}>`,
                                });
                            }
                        }

                        const notionAssigneeIds = [];
                        for (const info of assigneeSlackInfos) {
                            if (!info.email) continue;
                            try {
                                const nid = await getNotionUserIdByEmail(
                                    info.email
                                );
                                if (nid) notionAssigneeIds.push(nid);
                            } catch (err) {
                                console.error('Could not map Slack user', err);
                            }
                        }

                        let submittedByName = submittedBySlackId;
                        try {
                            if (submittedBySlackId) {
                                const sInfo = await slack.users.info({
                                    user: submittedBySlackId,
                                });
                                const p = sInfo?.user?.profile || {};
                                submittedByName =
                                    p.display_name ||
                                    p.real_name ||
                                    submittedBySlackId;
                            }
                        } catch (e) {}
                        let notionResult;
                        try {
                            notionResult = await createNotionTicket({
                                booking,
                                listing,
                                guest,
                                summary,
                                issues,
                                notionAssigneeIds,
                                assigneeNames: assigneeSlackInfos.map(
                                    x => x.name
                                ),
                                submittedByName,
                                attachments_present,
                                attachmentUrls: [],
                                thread_channel: null,
                                thread_ts: null,
                            });
                        } catch (err) {
                            console.error(
                                '[slack] Notion create failed ->',
                                err
                            );
                            return;
                        }

                        const channel = process.env.SLACK_ESCALATIONS_CHANNEL;
                        let ts = null;
                        let postedChannel = channel;

                        const mdText = buildMarkdownText({
                            booking,
                            listing,
                            guest,
                            issues,
                            summary,
                            assignees,
                            submittedByName,
                            notionUrl: notionResult.url,
                        });

                        if (firstFile) {
                            console.log(
                                `[slack] 1 file found (Modal ID: ${firstFile.id}). Uploading with files.uploadV2...`
                            );

                            const fileInfo = await slack.files.info({
                                file: firstFile.id,
                            });
                            const downloadUrl =
                                fileInfo.file?.url_private_download;
                            const response = await axios.get(downloadUrl, {
                                headers: {
                                    Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
                                },
                                responseType: 'arraybuffer',
                            });

                            const uploadResp = await slack.files.uploadV2({
                                channel_id: channel,
                                file: response.data,
                                filename: firstFile.name,
                                initial_comment: mdText,
                            });

                            if (
                                !uploadResp.ok ||
                                !uploadResp.files ||
                                uploadResp.files.length === 0
                            ) {
                                console.error(
                                    '[slack] files.uploadV2 failed (Top Level). Response:',
                                    uploadResp
                                );
                                return;
                            }
                            const fileUploadResult = uploadResp.files[0];
                            if (
                                !fileUploadResult.ok ||
                                !fileUploadResult.files ||
                                fileUploadResult.files.length === 0
                            ) {
                                console.error(
                                    '[slack] files.uploadV2 failed (Inner File). Response:',
                                    fileUploadResult
                                );
                                return;
                            }

                            const newUploadedFile = fileUploadResult.files[0];
                            const newFileId = newUploadedFile.id;

                            console.log(
                                `[slack] File re-uploaded. New Channel ID: ${newFileId}`
                            );

                            console.warn(
                                "[slack] Polling channel history for message 'ts' using NEW file ID..."
                            );

                            ts = await findMessageTsInHistory(
                                channel,
                                BOT_USER_ID,
                                newFileId
                            );
                        } else {
                            console.log(
                                '[slack] 0 files found. Using chat.postMessage...'
                            );

                            const postResp = await slack.chat.postMessage({
                                channel,
                                text: mdText,
                                mrkdwn: true,
                            });
                            ts = postResp.ts;
                        }

                        let threadUrl = null;
                        if (ts) {
                            try {
                                const permalinkResp =
                                    await slack.conversations.getPermalink({
                                        channel: postedChannel,
                                        message_ts: ts,
                                    });
                                threadUrl = permalinkResp?.permalink || null;
                            } catch (err) {
                                threadUrl = `https://slack.com/archives/${postedChannel}/p${String(
                                    ts
                                ).replace('.', '')}`;
                            }
                        } else {
                            console.warn(
                                "[slack] 'ts' is null, 'threadUrl' will also be null."
                            );
                        }

                        if (notionResult && notionResult.id) {
                            console.log(
                                '[slack] Data to send to Notion (update):',
                                {
                                    id: notionResult.id,
                                    thread_url: threadUrl,
                                    thread_channel: postedChannel,
                                    thread_ts: ts,
                                    attachments_present,
                                }
                            );

                            try {
                                await updateNotionTicketWithThread(
                                    notionResult.id,
                                    {
                                        thread_url: threadUrl,
                                        thread_channel: postedChannel,
                                        thread_ts: ts,
                                        attachments_present,
                                    }
                                );
                            } catch (err) {
                                console.warn(
                                    'Failed to update notion with thread fields',
                                    err?.message
                                );
                            }
                        }

                        if (ts) {
                            try {
                                await slack.reactions.add({
                                    name: 'new',
                                    channel: postedChannel,
                                    timestamp: ts,
                                });
                            } catch (_) {
                                try {
                                    await slack.reactions.add({
                                        name: 'white_check_mark',
                                        channel: postedChannel,
                                        timestamp: ts,
                                    });
                                } catch (e) {
                                    console.warn(
                                        'Could not add reaction',
                                        e?.message || e
                                    );
                                }
                            }
                        } else {
                            console.warn(
                                "[slack] 'ts' is null, skipping reaction."
                            );
                        }
                    } catch (err) {
                        console.error(
                            'Async background interactivity error',
                            err
                        );
                    }
                })();
                return;
            }
            res.status(200).send();
        } catch (err) {
            console.error('[slack/interactivity] verify error', err);
            return res.status(400).send('invalid signature');
        }
    }
);

router.post(
    '/commands',
    bodyParser.raw({ type: 'application/x-www-form-urlencoded' }),
    async (req, res) => {
        try {
            const raw = req.body.toString('utf8');
            if (!verifySlackSignature(raw, req)) {
                return res.status(400).send('invalid signature');
            }
            const params = Object.fromEntries(new URLSearchParams(raw));
            const { trigger_id } = params;
            res.status(200).send();
            const view = {
                type: 'modal',
                callback_id: 'escalation_modal',
                title: { type: 'plain_text', text: 'Create Escalation' },
                submit: { type: 'plain_text', text: 'Submit' },
                close: { type: 'plain_text', text: 'Cancel' },
                blocks: [
                    {
                        type: 'input',
                        block_id: 'booking',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'booking_ref',
                            placeholder: {
                                type: 'plain_text',
                                text: 'Reference number',
                            },
                        },
                        label: {
                            type: 'plain_text',
                            text: 'Booking reference',
                        },
                        hint: {
                            type: 'plain_text',
                            text: 'Enter the booking reference number.',
                        },
                    },
                    {
                        type: 'input',
                        block_id: 'listing',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'listing_name',
                            placeholder: {
                                type: 'plain_text',
                                text: 'Listing name',
                            },
                        },
                        label: { type: 'plain_text', text: 'Listing name' },
                        hint: {
                            type: 'plain_text',
                            text: 'Enter the name of the listing.',
                        },
                    },
                    {
                        type: 'input',
                        block_id: 'guest',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'guest_name',
                            placeholder: {
                                type: 'plain_text',
                                text: 'Guest full name',
                            },
                        },
                        label: { type: 'plain_text', text: 'Guest name' },
                        hint: {
                            type: 'plain_text',
                            text: 'Enter guest name.',
                        },
                    },
                    {
                        type: 'input',
                        block_id: 'issue',
                        element: {
                            type: 'checkboxes',
                            action_id: 'issue_type',
                            options: [
                                {
                                    text: {
                                        type: 'plain_text',
                                        text: 'Access/Check-in',
                                    },
                                    value: 'Access/Check-in',
                                },
                                {
                                    text: {
                                        type: 'plain_text',
                                        text: 'Cleanliness/Supplies',
                                    },
                                    value: 'Cleanliness/Supplies',
                                },
                                {
                                    text: {
                                        type: 'plain_text',
                                        text: 'Property condition',
                                    },
                                    value: 'Property condition',
                                },
                                {
                                    text: {
                                        type: 'plain_text',
                                        text: 'Noise/Disturbances',
                                    },
                                    value: 'Noise/Disturbances',
                                },
                                {
                                    text: {
                                        type: 'plain_text',
                                        text: 'Reservation/OTA Issues',
                                    },
                                    value: 'Reservation/OTA Issues',
                                },
                                {
                                    text: { type: 'plain_text', text: 'Other' },
                                    value: 'Other',
                                },
                            ],
                        },
                        label: { type: 'plain_text', text: 'Issue type' },
                        hint: {
                            type: 'plain_text',
                            text: 'Choose related issue types.',
                        },
                    },
                    {
                        type: 'input',
                        block_id: 'summary',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'summary',
                            multiline: true,
                            placeholder: {
                                type: 'plain_text',
                                text: 'Describe the issue and any immediate impact',
                            },
                        },
                        label: { type: 'plain_text', text: 'Summary' },
                        hint: {
                            type: 'plain_text',
                            text: "What's the escalation about?",
                        },
                    },
                    {
                        type: 'input',
                        block_id: 'assign',
                        element: {
                            type: 'multi_users_select',
                            action_id: 'assignees',
                            placeholder: {
                                type: 'plain_text',
                                text: 'Select one or more users',
                            },
                        },
                        label: { type: 'plain_text', text: 'Assign to' },
                    },
                    {
                        type: 'input',
                        optional: true,
                        block_id: 'input_block_id',
                        label: {
                            type: 'plain_text',
                            text: 'Attachments',
                        },
                        hint: {
                            type: 'plain_text',
                            text: 'Provide any support files.',
                        },
                        element: {
                            type: 'file_input',
                            action_id: 'file_input_action_id_1',
                            max_files: 5,
                        },
                    },
                ],
            };
            await slack.views.open({ trigger_id, view });
        } catch (err) {
            console.error('slash error', err);
        }
    }
);

router.post('/events', bodyParser.raw({ type: '*/*' }), async (req, res) => {
    try {
        const rawBody = req.body.toString('utf8');

        if (!verifySlackSignature(rawBody, req)) {
            console.warn('[slack/events] Invalid signature');
            return res.status(400).send('invalid signature');
        }

        const body = JSON.parse(rawBody);
        const { type, challenge, event } = body;

        if (type === 'url_verification') {
            console.log('[slack] Verifying events endpoint...');
            return res.status(200).send(challenge);
        }

        if (type === 'event_callback') {
            res.status(200).send();

            if (event.type === 'message' && !event.bot_id && !event.subtype) {
                const targetChannel = process.env.SLACK_COMMUNICATIONS_CHANNEL;

                if (event.channel === targetChannel) {
                    console.log(
                        `[slack] New message received in ${targetChannel}:`,
                        event.ts
                    );

                    try {
                        await db.query(
                            `INSERT INTO slack_messages 
                                (message_ts, thread_ts, user_id, channel_id, message_text, created_at)
                                VALUES ($1, $2, $3, $4, $5, NOW())
                                ON CONFLICT (message_ts) DO NOTHING`,
                            [
                                event.ts,
                                event.thread_ts || null,
                                event.user,
                                event.channel,
                                event.text,
                            ]
                        );
                        console.log('[db] Message saved successfully');
                    } catch (dbError) {
                        console.error(
                            '[db] Failed to save Slack message:',
                            dbError
                        );
                    }
                }
            }
            return;
        }

        return res.status(200).send();
    } catch (err) {
        console.error('[slack/events] Error processing request:', err);
        if (!res.headersSent)
            return res.status(500).send('Internal Server Error');
    }
});

module.exports = router;
