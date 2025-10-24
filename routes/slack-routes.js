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
            if (!verifySlackSignature(raw, req))
                return res.status(400).send('invalid signature');

            const payload = JSON.parse(raw);
            if (
                payload.type === 'view_submission' &&
                payload.view.callback_id === 'escalation_modal'
            ) {
                res.status(200).json({ response_action: 'clear' });

                const vals = payload.view.state.values;
                const booking = vals.booking?.booking_ref?.value || null;
                const listing = vals.listing?.listing_name?.value || null;
                const guest = vals.guest?.guest_name?.value || null;
                const summary = vals.summary?.summary?.value || null;
                const issues = (
                    vals.issue?.issue_type?.selected_options || []
                ).map(o => o.value);
                const assignees = vals.assign?.assignees?.selected_users || [];
                const submittedBySlackId = payload.user?.id;

                let notionResult;
                try {
                    notionResult = await createNotionTicket({
                        booking,
                        listing,
                        guest,
                        summary,
                        issues,
                        assignees,
                        submittedBySlackId,
                    });
                } catch (err) {
                    console.error('Notion create failed', err);
                    return;
                }

                try {
                    const channel = process.env.SLACK_ESCALATIONS_CHANNEL;
                    const text = `:rotating_light: New escalation created by <@${submittedBySlackId}> — <${notionResult.url}|Open ticket in Notion>`;
                    const postResp = await slack.chat.postMessage({
                        channel,
                        text,
                    });

                    const { ts, channel: postedChannel } = postResp;
                    const permalinkResp =
                        await slack.conversations.getPermalink({
                            channel: postedChannel,
                            message_ts: ts,
                        });
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

                return;
            }

            res.status(200).send();
        } catch (err) {
            console.error('Interactivity endpoint error', err);
            res.status(500).send();
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
                                    value: 'access',
                                },
                                {
                                    text: {
                                        type: 'plain_text',
                                        text: 'Cleanliness/Supplies',
                                    },
                                    value: 'clean',
                                },
                                {
                                    text: {
                                        type: 'plain_text',
                                        text: 'Property condition',
                                    },
                                    value: 'condition',
                                },
                                {
                                    text: {
                                        type: 'plain_text',
                                        text: 'Noise/Disturbances',
                                    },
                                    value: 'noise',
                                },
                                {
                                    text: {
                                        type: 'plain_text',
                                        text: 'Reservation/OTA Issues',
                                    },
                                    value: 'reservation',
                                },
                                {
                                    text: { type: 'plain_text', text: 'Other' },
                                    value: 'other',
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
                        block_id: 'attachments_hint',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'attachments_hint',
                            placeholder: {
                                type: 'plain_text',
                                text: 'Optional: paste URL(s) of attachments or leave instructions to upload in thread',
                            },
                        },
                        label: {
                            type: 'plain_text',
                            text: 'Attachments (optional)',
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
