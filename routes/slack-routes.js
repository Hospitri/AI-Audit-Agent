const express = require('express');
const crypto = require('crypto');
const { WebClient } = require('@slack/web-api');
const bodyParser = require('body-parser');
const {
    createNotionTicket,
    updateNotionTicketWithThread,
    getNotionUserIdByEmail,
} = require('../utils/notion-escalations.js');

const router = express.Router();
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

const notionUserEmailCache = new Map();

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

router.post(
    '/interactivity',
    bodyParser.raw({ type: '*/*' }),
    async (req, res) => {
        try {
            const raw = req.body.toString('utf8');
            console.log('[slack/interactivity] rawLen=', raw.length);
            console.log('[slack/interactivity] headers:', {
                ts: req.headers['x-slack-request-timestamp'],
                sig: req.headers['x-slack-signature'],
            });
            if (!verifySlackSignature(raw, req)) {
                console.warn(
                    '[slack/interactivity] signature verification failed'
                );
                console.warn(
                    '[slack/interactivity] signature verification failed'
                );
                return res.status(400).send('invalid signature');
            }

            const params = new URLSearchParams(raw);
            const payloadStr = params.get('payload');
            if (!payloadStr) {
                console.warn('[slack] interactivity: no payload param found');
                return res.status(400).send('missing payload');
            }

            let payload;
            try {
                payload = JSON.parse(payloadStr);
            } catch (err) {
                console.error(
                    '[slack/interactivity] failed to parse payload JSON',
                    err
                );
                return res.status(400).send('bad payload');
            }
            console.log(
                '[slack/interactivity] payload.type=',
                payload.type,
                'callback_id=',
                payload.view?.callback_id
            );

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

                        let attachments = [];
                        try {
                            const filesSelected =
                                vals.input_block_id?.file_input_action_id_1
                                    ?.selected_files || [];

                            for (const f of filesSelected) {
                                try {
                                    await slack.files.sharedPublicURL({
                                        file: f.id,
                                    });
                                } catch (e) {
                                    console.warn(
                                        'sharedPublicURL error (ok if disabled):',
                                        e?.data || e?.message || e
                                    );
                                }

                                try {
                                    const info = await slack.files.info({
                                        file: f.id,
                                    });
                                    const fileObj = info?.file || null;

                                    const pub =
                                        fileObj?.permalink_public ||
                                        fileObj?.permalink ||
                                        fileObj?.url_private ||
                                        null;

                                    if (pub) {
                                        attachments.push({
                                            id: f.id,
                                            url: pub,
                                            name: fileObj?.name || f.id,
                                        });
                                    } else {
                                        attachments.push({
                                            id: f.id,
                                            url: null,
                                            name: fileObj?.name || f.id,
                                        });
                                    }
                                } catch (e) {
                                    console.warn(
                                        'files.info failed for',
                                        f.id,
                                        e?.data || e?.message || e
                                    );
                                }
                            }
                        } catch (e) {
                            console.warn('attachments parsing failed', e);
                        }

                        const attachmentUrls = attachments
                            .map(a => a.url)
                            .filter(Boolean);
                        const attachments_present = attachmentUrls.length > 0;

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
                                console.warn(
                                    'users.info failed for',
                                    sid,
                                    e?.data || e?.message || e
                                );
                                assigneeSlackInfos.push({
                                    slackId: sid,
                                    email: null,
                                    name: `<@${sid}>`,
                                });
                            }
                        }

                        const notionAssigneeIds = [];
                        for (const info of assigneeSlackInfos) {
                            if (!info.email) {
                                console.error(
                                    '[slack->notion] missing email for Slack user',
                                    info.slackId
                                );
                                continue;
                            }
                            try {
                                const nid = await getNotionUserIdByEmail(
                                    info.email
                                );
                                if (!nid) {
                                    console.error(
                                        '[slack->notion] Could not map Slack user to Notion user by email',
                                        info.email
                                    );
                                } else {
                                    notionAssigneeIds.push(nid);
                                }
                            } catch (err) {
                                console.error(
                                    'Could not map Slack user to Notion user by email',
                                    info.email,
                                    err?.message || err
                                );
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
                        } catch (e) {
                            console.warn(
                                'Could not fetch submittedBy name',
                                e?.message || e
                            );
                        }

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
                                attachmentUrls,
                                thread_channel: null,
                                thread_ts: null,
                            });
                            console.log(
                                '[slack] createNotionTicket returned:',
                                notionResult
                            );
                            if (!notionResult || !notionResult.id) {
                                console.warn(
                                    '[slack] createNotionTicket returned no id, result:',
                                    notionResult
                                );
                            }
                        } catch (err) {
                            console.error('[slack] Notion create failed ->', {
                                message: err?.message,
                                stack: err?.stack,
                                response: err?.response || err?.body || null,
                            });
                            return;
                        }

                        const attachmentUrlsPublic = [];

                        for (const a of attachments) {
                            try {
                                await slack.files.sharedPublicURL({
                                    file: a.id,
                                });
                            } catch (e) {}
                            try {
                                const info = await slack.files.info({
                                    file: a.id,
                                });
                                const fileObj = info?.file || {};
                                const pub =
                                    fileObj?.permalink_public ||
                                    fileObj?.permalink ||
                                    fileObj?.url_private ||
                                    null;
                                if (pub)
                                    attachmentUrlsPublic.push({
                                        url: pub,
                                        name: fileObj?.name || a.name,
                                    });
                            } catch (e) {
                                console.warn(
                                    'files.info failed for',
                                    a.id,
                                    e?.data || e?.message || e
                                );
                            }
                        }

                        const attachmentsText = attachmentUrlsPublic.length
                            ? '\nAttachments:\n' +
                              attachmentUrlsPublic
                                  .map(u => `<${u.url}|${u.name}>`)
                                  .join('\n')
                            : '';

                        const blocks = [
                            {
                                type: 'section',
                                text: {
                                    type: 'mrkdwn',
                                    text: `:rotating_light: *New Escalation Submitted*\n*Booking reference:* ${
                                        booking || '-'
                                    }\n*Listing:* ${listing || '-'}\n*Guest:* ${
                                        guest || '-'
                                    }\n*Issue type:* ${
                                        (issues || []).join(', ') || '-'
                                    }\n*Summary:*\n${
                                        summary || '-'
                                    }\n––––––––––––––––––––––––––––––––––––––––\n*Assigned to:* ${
                                        assignees
                                            .map(id => `<@${id}>`)
                                            .join(', ') || '-'
                                    }\n*Submitted by:* ${submittedByName}\n${attachmentsText}\n<${
                                        notionResult.url
                                    }|Open ticket in Notion>\n\nPlease reply to this message in thread with any relevant update.`,
                                },
                            },
                        ];

                        try {
                            const channel =
                                process.env.SLACK_ESCALATIONS_CHANNEL;
                            const postResp = await slack.chat.postMessage({
                                channel,
                                blocks,
                                text: `New escalation: ${
                                    listing || booking || 'ticket'
                                }`,
                                unfurl_links: true,
                                unfurl_media: true,
                            });
                            const { ts, channel: postedChannel } = postResp;

                            const thread_channel = postedChannel;
                            const thread_ts = ts;

                            let threadUrl = null;
                            try {
                                if (
                                    slack.conversations &&
                                    typeof slack.conversations.getPermalink ===
                                        'function'
                                ) {
                                    const permalinkResp =
                                        await slack.conversations.getPermalink({
                                            channel: postedChannel,
                                            message_ts: ts,
                                        });
                                    threadUrl =
                                        permalinkResp?.permalink || null;
                                } else {
                                    threadUrl = `https://slack.com/archives/${postedChannel}/p${String(
                                        ts
                                    ).replace('.', '')}`;
                                }
                            } catch (err) {
                                threadUrl = `https://slack.com/archives/${postedChannel}/p${String(
                                    ts
                                ).replace('.', '')}`;
                            }

                            if (notionResult && notionResult.id) {
                                try {
                                    await updateNotionTicketWithThread(
                                        notionResult.id,
                                        {
                                            thread_url: threadUrl,
                                            thread_channel,
                                            thread_ts,
                                            attachments_present,
                                        }
                                    );
                                } catch (err) {
                                    console.warn(
                                        'Failed to update notion with thread fields',
                                        err?.message || err
                                    );
                                }
                            }

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
                        } catch (err) {
                            console.error('Slack postMessage failed', err);
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
            const { command, text, user_id, trigger_id } = params;

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
            try {
                if (!res.headersSent) res.status(500).send();
            } catch (e) {}
        }
    }
);

module.exports = router;
