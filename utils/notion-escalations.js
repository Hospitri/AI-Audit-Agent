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
        assigneeNames = [],
        notionAssigneeIds = [],
        submittedByName = '',
        attachments = [],
    } = values;

    const props = {};
    const prop = name => dbProperties[name] || null;

    const listingProp =
        prop('Listing') || prop('Listing name') || prop('Title');
    if (listingProp) {
        if (listingProp.type === 'title') {
            props[listingProp.name] = {
                title: [{ text: { content: listing || 'No listing' } }],
            };
        } else {
            props[listingProp.name] = {
                rich_text: [{ text: { content: listing || 'No listing' } }],
            };
        }
    }

    const bookingProp = prop('Booking reference') || prop('Booking');
    if (bookingProp) {
        if (bookingProp.type === 'title') {
            props[bookingProp.name] = {
                title: [{ text: { content: booking || '' } }],
            };
        } else {
            props[bookingProp.name] = {
                rich_text: [{ text: { content: booking || '' } }],
            };
        }
    }

    const guestProp = prop('Guest') || prop('Guest name');
    if (guestProp) {
        props[guestProp.name] = {
            rich_text: [{ text: { content: guest || '' } }],
        };
    }

    const summaryProp = prop('Summary');
    if (summaryProp) {
        props[summaryProp.name] = {
            rich_text: [{ text: { content: summary || '' } }],
        };
    }

    const issuesProp =
        prop('Issue type') || prop('Issue') || prop('Issue Type');
    if (issuesProp) {
        if (issuesProp.type === 'multi_select') {
            props[issuesProp.name] = {
                multi_select: (issues || []).map(i => ({ name: String(i) })),
            };
        } else {
            props[issuesProp.name] = {
                rich_text: [{ text: { content: (issues || []).join(', ') } }],
            };
        }
    }

    const assignProp = prop('Assigned To'); // **case-sensitive exact**
    if (assignProp) {
        if (assignProp.type === 'people') {
            if (Array.isArray(notionAssigneeIds) && notionAssigneeIds.length) {
                props[assignProp.name] = {
                    people: notionAssigneeIds.map(id => ({ id })),
                };
            } else {
                console.warn(
                    '[notion] Assigned To property is people but no notionAssigneeIds provided.'
                );
            }
        } else {
            props[assignProp.name] = {
                rich_text: [
                    { text: { content: assigneeNames.join(', ') || '' } },
                ],
            };
        }
    } else {
        console.warn(
            '[notion] WARNING: Database has no "Assigned To" property (case-sensitive).'
        );
    }

    const subProp = prop('Submitted by');
    if (subProp) {
        if (subProp.type === 'rich_text' || subProp.type === 'title') {
            props[subProp.name] = {
                rich_text: [{ text: { content: submittedByName || '' } }],
            };
        } else {
            props[subProp.name] = {
                rich_text: [{ text: { content: submittedByName || '' } }],
            };
        }
    }

    const attProp = prop('Attachments') || prop('Attachment');
    if (attProp) {
        if (attProp.type === 'files') {
            props[attProp.name] = {
                files: (attachments || []).map(url => ({
                    name: url.split('/').pop() || 'file',
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

    const payload = { parent: { database_id: dbId }, properties };

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
        await notion.pages.update(payload);
        return;
    }

    const propName = threadProp.name;
    let updatePayload = {};
    if (threadProp.type === 'url') {
        updatePayload[propName] = { url: fields.thread_url || null };
    } else {
        updatePayload[propName] = {
            rich_text: [{ text: { content: fields.thread_url || '' } }],
        };
    }

    await notion.pages.update({ page_id: pageId, properties: updatePayload });
}

module.exports = {
    createNotionTicket,
    updateNotionTicketWithThread,
    getNotionUserIdByEmail,
};
