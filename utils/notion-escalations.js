const { Client } = require('@notionhq/client');

const notion = new Client({
    auth: process.env.NOTION_TOKEN || process.env.NOTION_API_KEY,
});

function normalizeDbId(id) {
    if (!id) return id;
    return id.replace(/-/g, '');
}

function buildPropertyPayload(dbProperties, values = {}) {
    const {
        listing,
        booking,
        guest,
        summary,
        issues = [],
        assignees = [],
        submittedBySlackId,
        attachments = [],
    } = values;

    const props = {};
    const prop = name => dbProperties[name] || null;

    const listingProp = prop('Listing');
    if (listingProp) {
        if (listingProp.type === 'title') {
            props[listingProp.name] = {
                title: [{ text: { content: listing || 'No listing' } }],
            };
        } else if (listingProp.type === 'rich_text') {
            props[listingProp.name] = {
                rich_text: [{ text: { content: listing || 'No listing' } }],
            };
        }
    }

    const bookingProp = prop('Booking reference');
    if (bookingProp) {
        if (bookingProp.type === 'rich_text')
            props[bookingProp.name] = {
                rich_text: [{ text: { content: booking || '' } }],
            };
        else if (bookingProp.type === 'title')
            props[bookingProp.name] = {
                title: [{ text: { content: booking || '' } }],
            };
    }

    const guestProp = prop('Guest');
    if (guestProp) {
        if (guestProp.type === 'multi_select') {
            props[guestProp.name] = {
                multi_select: (guest || '')
                    .split(',')
                    .map(g => ({ name: g.trim() })),
            };
        } else {
            props[guestProp.name] = {
                rich_text: [{ text: { content: guest || '' } }],
            };
        }
    }

    const summaryProp = prop('Summary');
    if (summaryProp)
        props[summaryProp.name] = {
            rich_text: [{ text: { content: summary || '' } }],
        };

    const issuesProp = prop('Issue type');
    if (issuesProp) {
        if (issuesProp.type === 'multi_select') {
            props[issuesProp.name] = {
                multi_select: issues.map(i => ({ name: i })),
            };
        } else {
            props[issuesProp.name] = {
                rich_text: [{ text: { content: issues.join(', ') } }],
            };
        }
    }

    const assignProp = prop('Assigned To');
    if (assignProp) {
        if (assignProp.type === 'people') {
            props['Slack Assignees'] = {
                rich_text: [
                    {
                        text: {
                            content:
                                assignees.map(id => `<@${id}>`).join(', ') ||
                                'N/A',
                        },
                    },
                ],
            };
        } else {
            props[assignProp.name] = {
                rich_text: [
                    {
                        text: {
                            content:
                                assignees.map(id => `<@${id}>`).join(', ') ||
                                'N/A',
                        },
                    },
                ],
            };
        }
    }

    const subProp = prop('Submitted by');
    if (subProp)
        props[subProp.name] = {
            rich_text: [
                { text: { content: `<@${submittedBySlackId}>` || '-' } },
            ],
        };

    const attProp = prop('Attachments') || prop('Attachment');
    if (attProp) {
        if (attProp.type === 'files') {
            props[attProp.name] = {
                files: attachments.map(url => ({
                    name: url.split('/').pop(),
                    type: 'external',
                    external: { url },
                })),
            };
        } else {
            props[attProp.name] = {
                rich_text: [
                    { text: { content: (attachments || []).join(', ') } },
                ],
            };
        }
    }

    return props;
}

async function createNotionTicket(data = {}) {
    const dbIdRaw = process.env.NOTION_ESCALATIONS_DB_ID;
    if (!dbIdRaw) throw new Error('NOTION_ESCALATIONS_DB_ID not set');
    const dbId = normalizeDbId(dbIdRaw);

    let db;
    try {
        db = await notion.databases.retrieve({ database_id: dbId });
    } catch (err) {
        console.error('[notion] failed to retrieve database:', {
            dbId,
            errMessage: err?.message,
            errBody: err?.body || err?.response || null,
        });
        throw err;
    }
    const dbProps = db.properties || {};

    const properties = buildPropertyPayload(dbProps, data);

    if (!Object.keys(properties).length) {
        properties['Title'] = {
            title: [{ text: { content: data.listing || 'Ticket' } }],
        };
    }

    const payload = {
        parent: { database_id: dbId },
        properties,
    };

    console.log('[notion] creating page, payload sample:', {
        dbId,
        propertiesSent: Object.keys(properties),
    });

    try {
        const page = await notion.pages.create(payload);
        console.log('[notion] page created:', { id: page.id, url: page.url });
        return { id: page.id, url: page.url };
    } catch (err) {
        console.error('[notion] pages.create failed:', {
            message: err?.message,
            status: err?.status,
            body: err?.body || err?.response || null,
        });
        throw err;
    }
}

async function updateNotionTicketWithThread(pageId, fields = {}) {
    if (!pageId) throw new Error('pageId required');
    const dbIdRaw = process.env.NOTION_ESCALATIONS_DB_ID;
    if (!dbIdRaw) throw new Error('NOTION_ESCALATIONS_DB_ID not set');
    const dbId = normalizeDbId(dbIdRaw);

    const db = await notion.databases.retrieve({ database_id: dbId });
    const dbProps = db.properties || {};
    const threadProp =
        dbProps['Thread URL'] ||
        dbProps['Thread_URL'] ||
        dbProps['Thread'] ||
        null;

    if (!threadProp) {
        const payload = {
            page_id: pageId,
            properties: {
                'Thread URL': {
                    rich_text: [{ text: { content: fields.thread_url || '' } }],
                },
            },
        };
        try {
            await notion.pages.update(payload);
            return;
        } catch (err) {
            throw err;
        }
    }

    const propName = threadProp.name;

    let updatePayload = {};
    if (threadProp.type === 'url') {
        updatePayload[propName] = { url: fields.thread_url || null };
    } else if (threadProp.type === 'rich_text') {
        updatePayload[propName] = {
            rich_text: [{ text: { content: fields.thread_url || '' } }],
        };
    } else {
        updatePayload[propName] = {
            rich_text: [{ text: { content: fields.thread_url || '' } }],
        };
    }

    await notion.pages.update({ page_id: pageId, properties: updatePayload });
}

module.exports = { createNotionTicket, updateNotionTicketWithThread };
