const express = require('express');
const crypto = require('crypto');
const { WebClient } = require('@slack/web-api');
const bodyParser = require('body-parser');
const {
    createNotionTicket,
    updateNotionTicketWithThread,
} = require('../utils/notion-escalations.js');

const router = express.Router();
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

const notionUserEmailCache = new Map();

async function getNotionUserIdByEmail(email) {
    if (!email) return null;
    if (notionUserEmailCache.has(email)) return notionUserEmailCache.get(email);

    let cursor = undefined;
    do {
        const res = await notion.users.list({ start_cursor: cursor });
        for (const u of res.results || []) {
            if (u.type === 'person' && u.person && u.person.email) {
                if (u.person.email.toLowerCase() === email.toLowerCase()) {
                    notionUserEmailCache.set(email, u.id);
                    return u.id;
                }
            }
        }
        cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);

    notionUserEmailCache.set(email, null);
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
                        const vals = payload.view.state.values;
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
                        const submittedBySlackId = payload.user?.id;

                        let notionResult;
                        try {
                            console.log(
                                '[slack] creating notion ticket with:',
                                {
                                    booking,
                                    listing,
                                    guest,
                                    summary,
                                    issues,
                                    assignees,
                                    submittedBySlackId,
                                }
                            );

                            const attachments = [];
                            if (
                                vals.input_block_id?.file_input_action_id_1
                                    ?.selected_files
                            ) {
                                const files =
                                    vals.input_block_id.file_input_action_id_1
                                        .selected_files;
                                for (const f of files) {
                                    try {
                                        await slack.files.sharedPublicURL({
                                            file: f.id,
                                        });
                                    } catch (e) {
                                        console.warn(
                                            'sharedPublicURL failed',
                                            e?.data || e?.message || e
                                        );
                                    }
                                    try {
                                        const info = await slack.files.info({
                                            file: f.id,
                                        });
                                        const pubUrl =
                                            info?.file?.permalink_public ||
                                            info?.file?.url_private ||
                                            null;
                                        if (pubUrl) attachments.push(pubUrl);
                                    } catch (e) {
                                        console.warn(
                                            'files.info failed for',
                                            f.id,
                                            e?.data || e?.message || e
                                        );
                                    }
                                }
                            }

                            const assigneeSlackInfos = [];
                            for (const sid of assignees) {
                                try {
                                    const u = await slack.users.info({
                                        user: sid,
                                    });
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

                            let submittedByName = submittedBySlackId;
                            try {
                                const sInfo = await slack.users.info({
                                    user: submittedBySlackId,
                                });
                                const p = sInfo?.user?.profile || {};
                                submittedByName =
                                    p.display_name ||
                                    p.real_name ||
                                    submittedBySlackId;
                            } catch (e) {}

                            const notionAssigneeIds = [];
                            for (const info of assigneeSlackInfos) {
                                if (info.email) {
                                    try {
                                        const nid =
                                            await getNotionUserIdByEmail(
                                                info.email
                                            );
                                        if (nid) notionAssigneeIds.push(nid);
                                    } catch (e) {
                                        console.warn(
                                            'Could not map Slack user to Notion user by email',
                                            info.email,
                                            e?.message || e
                                        );
                                    }
                                }
                            }

                            notionResult = await createNotionTicket({
                                booking,
                                listing,
                                guest,
                                summary,
                                issues,
                                assignees,
                                assigneeNames: assigneeSlackInfos.map(
                                    x => x.name
                                ),
                                notionAssigneeIds,
                                submittedBySlackId,
                                submittedByName,
                                attachments,
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
                                response:
                                    err?.response?.body ||
                                    err?.response ||
                                    null,
                            });
                            return;
                        }

                        try {
                            const channel =
                                process.env.SLACK_ESCALATIONS_CHANNEL;
                            const text = [
                                ':rotating_light: *New Escalation Submitted*',
                                `*Booking reference:* ${booking || '-'}`,
                                `*Listing:* ${listing || '-'}`,
                                `*Guest:* ${guest || '-'}`,
                                `*Issue type:* ${
                                    (issues || []).join(', ') || '-'
                                }`,
                                `*Summary:*`,
                                `${summary || '-'}`,
                                '––––––––––––––––––––––––––––––––––––––––',
                                `*Assigned to:* ${
                                    assignees
                                        .map(id => `<@${id}>`)
                                        .join(', ') || '-'
                                }`,
                                `*Submitted by:* <@${submittedBySlackId}>`,
                                `<${notionResult.url}|Open ticket in Notion>`,
                                '',
                                'Please reply to this message in thread with any relevant update.',
                            ]
                                .join('\n')
                                .trim();

                            const postResp = await slack.chat.postMessage({
                                channel,
                                text,
                            });
                            const { ts, channel: postedChannel } = postResp;

                            const permalinkResp = await slack.chat.getPermalink(
                                {
                                    channel: postedChannel,
                                    message_ts: ts,
                                }
                            );

                            const threadUrl = permalinkResp?.permalink || null;

                            if (threadUrl) {
                                try {
                                    await updateNotionTicketWithThread(
                                        notionResult.id,
                                        { thread_url: threadUrl }
                                    );
                                } catch (err) {
                                    console.warn(
                                        'Failed to update notion with thread_url',
                                        err
                                    );
                                }
                            }

                            try {
                                await slack.reactions.add({
                                    name: 'white_check_mark',
                                    channel: postedChannel,
                                    timestamp: ts,
                                });
                            } catch (err) {
                                console.warn('Could not add reaction', err);
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
                                text: 'e.g. ABC123',
                            },
                        },
                        label: {
                            type: 'plain_text',
                            text: 'Booking reference',
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
                        element: {
                            type: 'file_input',
                            action_id: 'file_input_action_id_1',
                            filetypes: ['jpg', 'png'],
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
