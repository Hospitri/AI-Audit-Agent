const express = require('express');
const crypto = require('crypto');
const { WebClient } = require('@slack/web-api');
const bodyParser = require('body-parser');

const router = express.Router();
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

router.use('/slack/interactivity', bodyParser.raw({ type: '*/*' }));
router.use('/slack/commands', bodyParser.urlencoded({ extended: true }));

function verifySlackRequest(req) {
    const timestamp = req.headers['x-slack-request-timestamp'];
    const sig = req.headers['x-slack-signature'];
    if (!timestamp || !sig) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 60 * 5)
        return false;

    const body = req.rawBody || req.body; // raw for interactivity; for commands bodyParser already parsed
    const raw = Buffer.isBuffer(body)
        ? body.toString('utf8')
        : Object.keys(body).length
        ? Object.entries(body)
              .map(([k, v]) => `${k}=${v}`)
              .join('&')
        : '';
    const base = `v0:${timestamp}:${raw}`;
    const hmac = crypto
        .createHmac('sha256', SIGNING_SECRET)
        .update(base)
        .digest('hex');
    const computed = `v0=${hmac}`;
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sig));
}

router.post('/slack/commands', async (req, res) => {
    try {
        if (!verifySlackRequest(req))
            return res.status(400).send('invalid signature');
        const { command, text, user_id, trigger_id } = req.body;
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
                    },
                    label: { type: 'plain_text', text: 'Booking reference' },
                },
                {
                    type: 'input',
                    block_id: 'listing',
                    element: {
                        type: 'plain_text_input',
                        action_id: 'listing_name',
                    },
                    label: { type: 'plain_text', text: 'Listing name' },
                },
                {
                    type: 'input',
                    block_id: 'guest',
                    element: {
                        type: 'plain_text_input',
                        action_id: 'guest_name',
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
                    },
                    label: { type: 'plain_text', text: 'Summary' },
                },
                {
                    type: 'input',
                    block_id: 'assign',
                    element: {
                        type: 'multi_users_select',
                        action_id: 'assignees',
                    },
                    label: { type: 'plain_text', text: 'Assign to' },
                },
            ],
        };

        await slack.views.open({ trigger_id, view });
    } catch (err) {
        console.error('slash error', err);
        res.status(500).send();
    }
});

router.post('/slack/interactivity', async (req, res) => {
    try {
        req.rawBody = req.body.toString('utf8');
        if (!verifySlackRequest(req))
            return res.status(400).send('invalid signature');

        const payload = JSON.parse(req.rawBody);
        if (
            payload.type === 'view_submission' &&
            payload.view.callback_id === 'escalation_modal'
        ) {
            const vals = payload.view.state.values;
            const booking = vals.booking.booking_ref.value;
            const listing = vals.listing.listing_name.value;
            const guest = vals.guest.guest_name.value;
            const summary = vals.summary.summary.value;
            const issues = (vals.issue.issue_type.selected_options || []).map(
                o => o.value
            );
            const assignees = vals.assign.assignees.selected_users || [];

            res.status(200).json({ response_action: 'clear' });

            const notionPageUrl = await createNotionTicket({
                booking,
                listing,
                guest,
                summary,
                issues,
                assignees,
                slack_user_id: payload.user.id,
            });

            const channel =
                payload.view.private_metadata ||
                process.env.NOTIFICATIONS_CHANNEL;
            const text = `:ticket: New escalation created by <@${payload.user.id}> — <${notionPageUrl}|Open in Notion>`;
            await slack.chat.postMessage({ channel, text });

            return;
        }

        res.status(200).send();
    } catch (err) {
        console.error('interactivity error', err);
        res.status(500).send();
    }
});

module.exports = router;
