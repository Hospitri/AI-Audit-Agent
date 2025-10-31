const { Client } = require('@notionhq/client');

const notion = new Client({
    auth: process.env.NOTION_TOKEN || process.env.NOTION_API_KEY,
});

function normalizeDbId(id) {
    if (!id) return id;
    return id.replace(/-/g, '');
}

function normalizeName(s = '') {
    return String(s || '')
        .toLowerCase()
        .replace(/[_\s-]+/g, ' ')
        .replace(/[\W]+/g, '')
        .trim();
}

function findPropByName(dbProps, possibleNames = []) {
    const normalizedMap = Object.entries(dbProps || {}).reduce(
        (acc, [k, v]) => {
            acc[normalizeName(k)] = { key: k, prop: v };
            return acc;
        },
        {}
    );

    for (const n of possibleNames) {
        const nn = normalizeName(n);
        if (normalizedMap[nn]) return normalizedMap[nn];
    }
    return null;
}

function buildPropertyPayload(dbProperties, values = {}) {
    const {
        listing,
        booking,
        guest,
        summary,
        issues = [],
        notionAssigneeIds = [],
        assigneeNames = [],
        submittedByName,
        attachments = [],
        thread_channel,
        thread_ts,
    } = values;

    const props = {};

    const listingProp = findPropByName(dbProperties, [
        'Listing',
        'Listing name',
        'Title',
        'Name',
    ]);
    if (listingProp) {
        const name = listingProp.key;
        if (listingProp.prop.type === 'title') {
            props[name] = {
                title: [{ text: { content: listing || 'No listing' } }],
            };
        } else if (listingProp.prop.type === 'rich_text') {
            props[name] = {
                rich_text: [{ text: { content: listing || 'No listing' } }],
            };
        } else {
            props[name] = {
                rich_text: [{ text: { content: listing || 'No listing' } }],
            };
        }
    }

    const bookingProp = findPropByName(dbProperties, [
        'Booking reference',
        'Booking',
        'Booking Reference',
    ]);
    if (bookingProp) {
        const name = bookingProp.key;
        if (bookingProp.prop.type === 'title') {
            props[name] = { title: [{ text: { content: booking || '' } }] };
        } else {
            props[name] = { rich_text: [{ text: { content: booking || '' } }] };
        }
    }

    const guestProp = findPropByName(dbProperties, [
        'Guest',
        'Guest name',
        'Guest Name',
    ]);
    if (guestProp) {
        const name = guestProp.key;
        if (guestProp.prop.type === 'multi_select') {
            const items =
                typeof guest === 'string' && guest.length
                    ? guest.split(',').map(g => ({ name: g.trim() }))
                    : [];
            props[name] = { multi_select: items };
        } else {
            props[name] = { rich_text: [{ text: { content: guest || '' } }] };
        }
    }

    const summaryProp = findPropByName(dbProperties, ['Summary']);
    if (summaryProp) {
        props[summaryProp.key] = {
            rich_text: [{ text: { content: summary || '' } }],
        };
    }

    const issuesProp = findPropByName(dbProperties, [
        'Issue type',
        'Issue',
        'Issue Type',
    ]);
    if (issuesProp) {
        if (
            issuesProp.prop.type === 'multi_select' ||
            issuesProp.prop.type === 'select'
        ) {
            props[issuesProp.key] = {
                multi_select: (issues || []).map(i => ({ name: String(i) })),
            };
        } else {
            props[issuesProp.key] = {
                rich_text: [{ text: { content: (issues || []).join(', ') } }],
            };
        }
    }

    const assignProp = findPropByName(dbProperties, [
        'Assigned To',
        'Assigned',
        'Assignee',
        'Assignee (Slack)',
    ]);
    if (assignProp) {
        const name = assignProp.key;
        if (assignProp.prop.type === 'people') {
            props[name] = {
                people: Array.isArray(notionAssigneeIds)
                    ? notionAssigneeIds.map(id => ({ id }))
                    : [],
            };
            const fallback = findPropByName(dbProperties, [
                'Assignee (Slack IDs)',
                'Assignee Slack IDs',
                'Assignee Slack',
            ]);
            if (fallback) {
                props[fallback.key] = {
                    rich_text: [
                        { text: { content: (assigneeNames || []).join(', ') } },
                    ],
                };
            }
        } else {
            props[name] = {
                rich_text: [
                    { text: { content: (assigneeNames || []).join(', ') } },
                ],
            };
        }
    }

    const subProp = findPropByName(dbProperties, [
        'Submitted by',
        'Submitted_by',
        'Submitted',
    ]);
    if (subProp) {
        props[subProp.key] = {
            rich_text: [{ text: { content: String(submittedByName || '') } }],
        };
    }

    const attProp = findPropByName(dbProperties, [
        'Attachments',
        'Attachment',
        'Files',
        'Files and Media',
    ]);
    if (attProp) {
        const name = attProp.key;
        if (attProp.prop.type === 'files') {
            props[name] = {
                files: (attachments || []).map(url => ({
                    name: url.split('/').pop() || 'file',
                    type: 'external',
                    external: { url },
                })),
            };
        } else {
            props[name] = {
                rich_text: [
                    { text: { content: (attachments || []).join(', ') } },
                ],
            };
        }
    }

    const threadChannelProp = findPropByName(dbProperties, [
        'Thread Channel ID',
        'Thread_Channel_ID',
        'Thread Channel',
    ]);
    if (threadChannelProp && thread_channel) {
        props[threadChannelProp.key] = {
            rich_text: [{ text: { content: String(thread_channel) } }],
        };
    }

    const threadTsProp = findPropByName(dbProperties, [
        'Thread TS',
        'Thread_TS',
        'Thread Timestamp',
        'Thread TS',
    ]);
    if (threadTsProp && thread_ts) {
        props[threadTsProp.key] = {
            rich_text: [{ text: { content: String(thread_ts) } }],
        };
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

    console.log('[notion] database properties:', Object.keys(dbProps || {}));

    const properties = buildPropertyPayload(dbProps, data);

    if (!Object.keys(properties).length) {
        const titleName =
            Object.keys(dbProps).find(k => dbProps[k].type === 'title') ||
            'Name';
        properties[titleName] = {
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
    const propsToUpdate = {};

    const threadChannelProp = findPropByName(dbProps, [
        'Thread Channel ID',
        'Thread_Channel_ID',
        'Thread Channel',
    ]);
    if (threadChannelProp && fields.thread_channel) {
        propsToUpdate[threadChannelProp.key] = {
            rich_text: [{ text: { content: String(fields.thread_channel) } }],
        };
    }

    const threadTsProp = findPropByName(dbProps, [
        'Thread TS',
        'Thread_TS',
        'Thread Timestamp',
    ]);
    if (threadTsProp && fields.thread_ts) {
        propsToUpdate[threadTsProp.key] = {
            rich_text: [{ text: { content: String(fields.thread_ts) } }],
        };
    }

    const threadUrlProp = findPropByName(dbProps, [
        'Thread URL',
        'Thread_URL',
        'Thread',
    ]);
    if (threadUrlProp && fields.thread_url) {
        if (threadUrlProp.prop.type === 'url') {
            propsToUpdate[threadUrlProp.key] = { url: fields.thread_url };
        } else {
            propsToUpdate[threadUrlProp.key] = {
                rich_text: [{ text: { content: fields.thread_url } }],
            };
        }
    }

    if (Object.keys(propsToUpdate).length === 0) return;

    await notion.pages.update({ page_id: pageId, properties: propsToUpdate });
}

module.exports = { createNotionTicket, updateNotionTicketWithThread };
