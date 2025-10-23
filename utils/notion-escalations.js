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

    const titleProp = prop('Listing') || prop('Title') || prop('Name');
    if (titleProp) {
        props[titleProp.name || 'Listing'] = {
            title: [{ text: { content: listing || 'No listing' } }],
        };
    } else {
        props['Listing'] = {
            rich_text: [{ text: { content: listing || 'No listing' } }],
        };
    }

    const bookingProp =
        prop('Booking reference') ||
        prop('Booking') ||
        prop('Booking Reference');
    if (bookingProp) {
        if (bookingProp.type === 'rich_text') {
            props[bookingProp.name] = {
                rich_text: [{ text: { content: booking || '' } }],
            };
        } else if (bookingProp.type === 'title') {
            props[bookingProp.name] = {
                title: [{ text: { content: booking || '' } }],
            };
        } else {
            props[bookingProp.name] = {
                rich_text: [{ text: { content: booking || '' } }],
            };
        }
    }

    const guestProp = prop('Guest') || prop('Guest name') || prop('Guest Name');
    if (guestProp)
        props[guestProp.name] = {
            rich_text: [{ text: { content: guest || '' } }],
        };

    const summaryProp = prop('Summary');
    if (summaryProp)
        props[summaryProp.name] = {
            rich_text: [{ text: { content: summary || '' } }],
        };

    const issuesProp =
        prop('Issue type') || prop('Issue Type') || prop('Issue');
    if (issuesProp) {
        if (
            issuesProp.type === 'multi_select' ||
            issuesProp.type === 'select'
        ) {
            props[issuesProp.name] = {
                multi_select: issues.map(i => ({ name: String(i) })),
            };
        } else {
            props[issuesProp.name] = {
                rich_text: [{ text: { content: (issues || []).join(', ') } }],
            };
        }
    }

    const assignProp =
        prop('Assigned To') || prop('Assigned') || prop('Assignee');
    if (assignProp) {
        if (assignProp.type === 'people') {
            props[assignProp.name] = {
                rich_text: [{ text: { content: assignees.join(', ') } }],
            };
        } else {
            props[assignProp.name] = {
                rich_text: [{ text: { content: assignees.join(', ') } }],
            };
        }
    }

    const subProp =
        prop('Submitted by') || prop('Submitted_by') || prop('Submitted');
    if (subProp)
        props[subProp.name] = {
            rich_text: [
                { text: { content: String(submittedBySlackId || '') } },
            ],
        };

    const threadProp =
        prop('Thread URL') || prop('Thread_URL') || prop('Thread');
    if (threadProp) {
    }

    const attProp = prop('Attachments') || prop('Attachment');
    if (attProp) {
        props[attProp.name] = {
            rich_text: [{ text: { content: (attachments || []).join(', ') } }],
        };
    }

    return props;
}

async function createNotionTicket(data = {}) {
    const dbIdRaw = process.env.NOTION_ESCALATIONS_DB_ID;
    if (!dbIdRaw) throw new Error('NOTION_ESCALATIONS_DB_ID not set');
    const dbId = normalizeDbId(dbIdRaw);

    const db = await notion.databases.retrieve({ database_id: dbId });
    const dbProps = db.properties || {};

    const properties = buildPropertyPayload(dbProps, data);

    if (!Object.keys(properties).length) {
        properties['Title'] = {
            title: [{ text: { content: data.listing || 'Ticket' } }],
        };
    }

    const page = await notion.pages.create({
        parent: { database_id: dbId },
        properties,
    });

    return { id: page.id, url: page.url };
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
