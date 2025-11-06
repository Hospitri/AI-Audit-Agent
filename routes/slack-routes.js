const express = require('express');
const crypto = require('crypto');
const { WebClient } = require('@slack/web-api');
const bodyParser = require('body-parser');
const axios = require('axios');
const {
    createNotionTicket,
    updateNotionTicketWithThread,
    getNotionUserIdByEmail,
} = require('../utils/notion-escalations.js');

const router = express.Router();
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

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
                        let ts, postedChannel;

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
                                '[slack] 1 file found. Uploading with files.uploadV2...'
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

                            ts = uploadResp.file.shares.public[channel][0].ts;
                            postedChannel = channel;
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
                            postedChannel = postResp.channel;
                        }

                        let threadUrl = null;
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

                        if (notionResult && notionResult.id) {
                            try {
                                console.log('[slack] Sending to Notion:', {
                                    id: notionResult.id,
                                    thread_url: threadUrl,
                                    thread_channel: postedChannel,
                                    thread_ts: ts,
                                    attachments_present,
                                });
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

                        try {
                            await slack.reactions.add({
                                name: 'new',
                                channel: postedChannel,
                                timestamp: ts,
                            });
                        } catch (_) {}
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

module.exports = router;
