const { Client } = require('@notionhq/client');

const notion = new Client({
    auth: process.env.NOTION_TOKEN || process.env.NOTION_API_KEY,
});

function normalizeDbId(id) {
    if (!id) return id;
    return id.replace(/-/g, '');
}

const notionUserEmailCache = new Map();

async function getNotionUserIdByEmail(email) {
    if (!email) return null;
    if (notionUserEmailCache.has(email)) return notionUserEmailCache.get(email);

    let cursor = undefined;
    try {
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
    } catch (err) {
        console.error('[notion] users.list failed', {
            err: err?.message || err,
        });
    }

    notionUserEmailCache.set(email, null);
    return null;
}

function findPropByNames(dbProps, names = []) {
    for (const n of names) {
        if (Object.prototype.hasOwnProperty.call(dbProps, n)) return dbProps[n];
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
        attachments_present,
        attachmentUrls = [],
        thread_channel,
        thread_ts,
    } = values;

    const props = {};
    const findPropByName = (names = []) => {
        for (const n of names) {
            if (Object.prototype.hasOwnProperty.call(dbProperties, n))
                return { key: n, prop: dbProperties[n] };
        }
        return null;
    };

    const listingProp = findPropByName([
        'Listing',
        'Listing name',
        'Title',
        'Name',
    ]);
    if (listingProp) {
        const name = listingProp.key;
        const type = listingProp.prop?.type;
        if (type === 'title') {
            props[name] = {
                title: [{ text: { content: listing || 'No listing' } }],
            };
        } else if (type === 'rich_text') {
            props[name] = {
                rich_text: [{ text: { content: listing || 'No listing' } }],
            };
        } else {
            props[name] = {
                rich_text: [{ text: { content: listing || 'No listing' } }],
            };
        }
    }

    const bookingProp = findPropByName(['Booking reference', 'Booking']);
    if (bookingProp) {
        const name = bookingProp.key;
        const type = bookingProp.prop?.type;
        if (type === 'title')
            props[name] = { title: [{ text: { content: booking || '' } }] };
        else
            props[name] = { rich_text: [{ text: { content: booking || '' } }] };
    }

    const guestProp = findPropByName(['Guest', 'Guest name', 'Guest Name']);
    if (guestProp) {
        const name = guestProp.key;
        const type = guestProp.prop?.type;
        if (type === 'multi_select') {
            const items =
                typeof guest === 'string' && guest.length
                    ? guest.split(',').map(g => ({ name: g.trim() }))
                    : [];
            props[name] = { multi_select: items };
        } else {
            props[name] = { rich_text: [{ text: { content: guest || '' } }] };
        }
    }

    const summaryProp = findPropByName(['Summary']);
    if (summaryProp)
        props[summaryProp.key] = {
            rich_text: [{ text: { content: summary || '' } }],
        };

    const issuesProp = findPropByName(['Issue type', 'Issue', 'Issue Type']);
    if (issuesProp) {
        const type = issuesProp.prop?.type;
        if (type === 'multi_select' || type === 'select') {
            props[issuesProp.key] = {
                multi_select: (issues || []).map(i => ({ name: String(i) })),
            };
        } else {
            props[issuesProp.key] = {
                rich_text: [{ text: { content: (issues || []).join(', ') } }],
            };
        }
    }

    const assignProp = findPropByName(['Assigned To', 'Assigned', 'Assignee']);
    if (assignProp) {
        const name = assignProp.key;
        const type = assignProp.prop?.type;
        if (type === 'people') {
            props[name] = {
                people: Array.isArray(notionAssigneeIds)
                    ? notionAssigneeIds.map(id => ({ id }))
                    : [],
            };
        } else {
            props[name] = {
                rich_text: [
                    { text: { content: (assigneeNames || []).join(', ') } },
                ],
            };
        }
    }

    const subProp = findPropByName([
        'Submitted by',
        'Submitted_by',
        'Submitted',
    ]);
    if (subProp) {
        props[subProp.key] = {
            rich_text: [{ text: { content: String(submittedByName || '') } }],
        };
    }

    const attProp = findPropByName([
        'Attachments',
        'Attachment',
        'Has Attachments',
        'Has attachments',
        'Attachments Present',
    ]);
    if (attProp) {
        const name = attProp.key;
        const type = attProp.prop?.type;
        if (type === 'checkbox') {
            props[name] = { checkbox: Boolean(attachments_present) };
        } else if (type === 'files') {
            props[name] = {
                files: (attachmentUrls || []).map(url => ({
                    name: (url || '').split('/').pop() || 'file',
                    type: 'external',
                    external: { url },
                })),
            };
        } else {
            props[name] = {
                rich_text: [
                    {
                        text: {
                            content: attachments_present ? 'Yes' : 'No',
                        },
                    },
                ],
            };
        }
    }

    const threadChannelProp = findPropByName([
        'Thread Channel ID',
        'Thread_Channel_ID',
        'Thread Channel',
    ]);
    if (threadChannelProp && thread_channel) {
        props[threadChannelProp.key] = {
            rich_text: [{ text: { content: String(thread_channel) } }],
        };
    }
    const threadTsProp = findPropByName([
        'Thread TS',
        'Thread_TS',
        'Thread Timestamp',
    ]);
    if (threadTsProp && thread_ts) {
        props[threadTsProp.key] = {
            rich_text: [{ text: { content: String(thread_ts) } }],
        };
    }
    const threadUrlProp = findPropByName([
        'Thread URL',
        'Thread_URL',
        'Thread',
    ]);
    if (threadUrlProp && values.thread_url) {
        if (threadUrlProp.prop?.type === 'url')
            props[threadUrlProp.key] = { url: values.thread_url };
        else
            props[threadUrlProp.key] = {
                rich_text: [{ text: { content: values.thread_url } }],
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
            errMessage: err?.message || err,
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
    const templateId = process.env.NOTION_TEMPLATE_ID;
    let templateChildren = [];

    if (templateId) {
        try {
            const response = await notion.blocks.children.list({
                block_id: templateId,
            });
            templateChildren = response.results || [];
        } catch (e) {
            console.warn(
                `[notion] Could not retrieve template children for ID ${templateId}`,
                e?.message
            );
        }
    }

    const payload = {
        parent: { database_id: dbId },
        properties,
        children: templateChildren.length ? templateChildren : undefined,
    };

    console.log('[notion] creating page, payload sample:', {
        dbId,
        propertiesSent: Object.keys(properties),
        usingTemplateChildren: templateChildren.length > 0,
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

    let db;
    try {
        db = await notion.databases.retrieve({ database_id: dbId });
    } catch (dbErr) {
        console.error(
            '[notion] update: failed to retrieve database',
            dbErr?.message
        );
        return;
    }

    const dbProps = db.properties || {};
    const updatePayload = {};

    const threadProp =
        dbProps['Thread URL'] ||
        dbProps['Thread_URL'] ||
        dbProps['Thread'] ||
        null;

    if (threadProp && fields.thread_url) {
        const propName = threadProp.name;
        if (threadProp.type === 'url') {
            updatePayload[propName] = { url: fields.thread_url || null };
        } else {
            updatePayload[propName] = {
                rich_text: [{ text: { content: fields.thread_url || '' } }],
            };
        }
    } else if (fields.thread_url) {
        updatePayload['Thread URL'] = {
            rich_text: [{ text: { content: fields.thread_url || '' } }],
        };
    }

    const threadChannelProp =
        dbProps['Thread Channel ID'] ||
        dbProps['Thread_Channel_ID'] ||
        dbProps['Thread Channel'];

    if (threadChannelProp && fields.thread_channel) {
        updatePayload[threadChannelProp.name] = {
            rich_text: [{ text: { content: String(fields.thread_channel) } }],
        };
    }

    const threadTsProp =
        dbProps['Thread TS'] ||
        dbProps['Thread_TS'] ||
        dbProps['Thread Timestamp'];

    if (threadTsProp && fields.thread_ts) {
        updatePayload[threadTsProp.name] = {
            rich_text: [{ text: { content: String(fields.thread_ts) } }],
        };
    }

    const attProp =
        dbProps['Attachments'] ||
        dbProps['Attachment'] ||
        dbProps['Has Attachments'];

    if (
        attProp &&
        attProp.type === 'checkbox' &&
        fields.attachments_present !== undefined
    ) {
        updatePayload[attProp.name] = {
            checkbox: Boolean(fields.attachments_present),
        };
    }

    if (Object.keys(updatePayload).length === 0) {
        console.warn('[notion] update: No properties found to update.');
        return;
    }

    try {
        console.log(
            '[notion] Updating page with thread fields:',
            Object.keys(updatePayload)
        );
        await notion.pages.update({
            page_id: pageId,
            properties: updatePayload,
        });
    } catch (updateErr) {
        console.error('[notion] pages.update failed', updateErr?.message);
    }
}

module.exports = {
    createNotionTicket,
    updateNotionTicketWithThread,
    getNotionUserIdByEmail,
};
