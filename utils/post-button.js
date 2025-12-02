require('dotenv').config();
const { WebClient } = require('@slack/web-api');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const CHANNEL_ID = 'C08FNP7MTFA';

(async () => {
    try {
        await slack.chat.postMessage({
            channel: CHANNEL_ID,
            text: 'Create a new escalation ticket',
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: '🚨 *Need to report an issue?*\nUse the button below to open the escalation form directly.',
                    },
                },
                {
                    type: 'actions',
                    elements: [
                        {
                            type: 'button',
                            text: {
                                type: 'plain_text',
                                text: 'Create Escalation',
                                emoji: true,
                            },
                            style: 'primary',
                            action_id: 'open_escalation_modal_button',
                        },
                    ],
                },
            ],
        });
        console.log('✅ Button posted successfully!');
    } catch (error) {
        console.error('❌ Error posting button:', error);
    }
})();
